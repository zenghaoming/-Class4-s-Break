'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { randomUUID } = require('node:crypto');
const { io } = require('socket.io-client');
const cookie = require('cookie');
const { createApplication } = require('../server');

async function environment(t, settings = {}) {
    const app = createApplication({ aiDelayMs: 40, actionTimeoutMs: 5000, reconnectGraceMs: 80, ...settings });
    const address = await app.listen(0, '127.0.0.1');
    const url = `http://127.0.0.1:${address.port}`;
    const clients = [];
    t.after(async () => { for (const client of clients) client.socket.disconnect(); await app.close(); });
    async function client(existingCookie) {
        let header = existingCookie;
        if (!header) {
            const response = await fetch(url + '/api/session'); assert.equal(response.status, 200);
            header = cookie.serialize('class4_session', cookie.parse(response.headers.getSetCookie()[0]).class4_session);
        }
        const socket = io(url, { transports: ['websocket'], extraHeaders: { Cookie: header, Origin: url }, autoConnect: false, reconnection: false });
        const result = { socket, header, state: null, messages: [], rejected: [], events: [] };
        socket.on('sync_game_state', state => { result.state = state; });
        socket.on('new_chat_message', data => result.messages.push(data));
        socket.on('action_rejected', data => result.rejected.push(data));
        socket.onAny((event, data) => result.events.push({ event, data }));
        await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
        clients.push(result); return result;
    }
    return { app, url, client };
}
function request(client, event, data = {}) {
    return new Promise((resolve, reject) => client.socket.timeout(2000).emit(event, data, (error, result) => error ? reject(error) : resolve(result)));
}
async function join(env, name = '测试玩家', code = 'TEST', existingCookie) {
    const client = await env.client(existingCookie);
    const result = await request(client, 'join_room', { name, roomCode: code });
    assert.equal(result.ok, true, JSON.stringify(result)); client.seat = result.seat; return client;
}
async function table(env, code = 'TEST') { const clients = []; for (let i = 0; i < 4; i++) clients.push(await join(env, `测试${i}`, code)); return clients; }
function moveData(client, data = {}) { return { ...data, gameId: client.state.gameId, decisionId: client.state.decisionId, actionId: randomUUID() }; }
async function until(predicate, timeout = 2000) {
    const end = Date.now() + timeout;
    while (!predicate() && Date.now() < end) await delay(10);
    assert(predicate(), '等待真实事件超过期限');
}
function configureClaim(game) {
    const pool = [...game.registry.keys()];
    const take = name => { const index = pool.findIndex(id => game.name(id) === name); assert(index >= 0); return pool.splice(index, 1)[0]; };
    const hands = [['顾忻乐', '彭籽稼'], ['侯俊贤', '朱喆宇', '戴宇豪', '温秦富'], ['夏运', '唐洋'], ['范文豪', '杨嘉毅']];
    game.players.forEach((p, i) => { p.hand = hands[i].map(take); p.bonds = []; p.discards = []; });
    game.pendingCardInfo = { cards: [take('顾嘉誉')], card: '顾嘉誉', rawCard: '顾嘉誉', fromPlayer: 0, unclaimable: false, isHatCombo: false };
    game.deck = pool; game.gameState = 'WAITING_ACTION'; game.turn = 0;
    game.changed();
}

test('页面、健康接口、Cookie属性与源码隔离', async t => {
    const env = await environment(t);
    for (const route of ['/', '/index.html', '/multiplayer.html', '/rules.js', '/app.js', '/styles.css', '/socket.io/socket.io.js']) assert.equal((await fetch(env.url + route)).status, 200, route);
    for (const route of ['/server.js', '/game.js', '/package.json']) assert.equal((await fetch(env.url + route)).status, 404, route);
    const health = await fetch(env.url + '/healthz'); assert.equal((await health.json()).status, 'ok');
    const session = await fetch(env.url + '/api/session'); const header = session.headers.getSetCookie()[0]; assert(header.includes('HttpOnly')); assert(header.includes('SameSite=Strict'));
    assert((await fetch(env.url)).headers.get('content-security-policy').includes("script-src 'self'"));
});
test('未认证Socket连接被拒绝', async t => {
    const env = await environment(t); const socket = io(env.url, { transports: ['websocket'], reconnection: false, autoConnect: false });
    t.after(() => socket.disconnect());
    const error = await new Promise(resolve => { socket.once('connect_error', resolve); socket.connect(); }); assert(error.message.includes('会话'));
});
test('四客户端入座且仅收到本人隐藏手牌', async t => {
    const env = await environment(t); const clients = await table(env);
    assert.deepEqual(clients.map(c => c.seat), [0, 1, 2, 3]);
    assert((await request(clients[0], 'force_start_game')).ok);
    await until(() => clients.every(c => c.state?.gameState === 'PLAYING'));
    for (const client of clients) {
        assert(client.state.playersData[client.seat].hand.length >= 9);
        for (const player of client.state.playersData) if (player.seat !== client.seat) { assert.equal(Object.hasOwn(player, 'hand'), false); assert.equal(Object.hasOwn(player, 'ownerId'), false); }
    }
});
test('第五个访客满员提示且不接收牌局广播', async t => {
    const env = await environment(t); const clients = await table(env); const fifth = await env.client();
    assert.equal((await request(fifth, 'join_room', { name: '访客', roomCode: 'TEST' })).code, 'ROOM_FULL');
    await request(clients[0], 'force_start_game'); await delay(30);
    assert.equal(fifth.state, null); assert(fifth.events.some(e => e.event === 'room_full'));
    assert.equal((await request(fifth, 'restart_game')).code, 'NOT_JOINED');
});
test('昵称与聊天原文通过真实通信传送，客户端使用文本渲染', async t => {
    const env = await environment(t); const clients = await table(env);
    assert((await request(clients[0], 'update_name', { name: '<b>QA</b>' })).ok);
    const payload = '<img src=x onerror=window.q=1>';
    assert((await request(clients[0], 'send_chat', { text: payload })).ok);
    await until(() => clients[1].messages.length === 1);
    assert.equal(clients[1].messages[0].text, payload); assert.equal(clients[1].state.playersData[0].name, '<b>QA</b>');
});
test('聊天长度、类型与发送频率限制', async t => {
    const env = await environment(t); const client = await join(env);
    assert.equal((await request(client, 'send_chat', { text: {} })).code, 'INVALID_CHAT');
    assert.equal((await request(client, 'send_chat', { text: 'a'.repeat(81) })).code, 'INVALID_CHAT');
    assert.equal((await request(client, 'send_chat', { text: ' ' })).code, 'INVALID_CHAT');
    await request(client, 'send_chat', { text: '测试1' }); await request(client, 'send_chat', { text: '测试2' });
    assert.equal((await request(client, 'send_chat', { text: '测试3' })).code, 'RATE_LIMIT');
});
test('房间之间隔离聊天、状态与控制', async t => {
    const env = await environment(t); const first = await join(env, '甲', 'ONE'); const second = await join(env, '乙', 'TWO');
    await request(first, 'send_chat', { text: '仅第一房间' }); await request(first, 'fill_ai_players'); await delay(30);
    assert.equal(second.messages.length, 0); assert.equal(second.state.gameState, 'WAITING_PLAYERS'); assert.equal(second.state.deckCount, 0);
});
test('非房主无法重开、补位或清空AI', async t => {
    const env = await environment(t); const clients = await table(env); await request(clients[0], 'force_start_game');
    for (const command of ['restart_game', 'force_start_game', 'fill_ai_players', 'clear_ai_players']) assert.equal((await request(clients[1], command)).code, 'HOST_ONLY');
});
test('大厅重开检查人数，立即开局补齐AI', async t => {
    const env = await environment(t); const client = await join(env);
    assert.equal((await request(client, 'restart_game')).code, 'MISSING_PLAYERS'); assert.equal(client.state.gameState, 'WAITING_PLAYERS');
    assert((await request(client, 'force_start_game')).ok); assert.equal(client.state.playersData.filter(p => p.isAI).length, 3);
});
test('重连凭证恢复本人席位，新访客无法占用', async t => {
    const env = await environment(t, { reconnectGraceMs: 1000 }); const clients = await table(env); await request(clients[0], 'force_start_game');
    const hand = clients[0].state.playersData[0].hand; const header = clients[0].header;
    clients[0].socket.disconnect(); await until(() => clients[1].state.playersData[0].connected === false);
    const stranger = await env.client(); assert.equal((await request(stranger, 'join_room', { name: '陌生访客', roomCode: 'TEST' })).code, 'ROOM_FULL');
    const restored = await join(env, '测试0', 'TEST', header); assert.equal(restored.seat, 0); assert.deepEqual(restored.state.playersData[0].hand, hand);
});
test('断线当前行动者由AI继续，重连可恢复操作', async t => {
    const env = await environment(t); const clients = await table(env); await request(clients[0], 'force_start_game');
    const decision = clients[0].state.decisionId; clients[0].socket.disconnect();
    await until(() => clients[1].state.gameId === clients[0].state.gameId && clients[1].state.decisionId !== decision);
    assert.equal(clients[1].state.playersData[0].isAI, true);
    const restored = await join(env, '测试0', 'TEST', clients[0].header); assert.equal(restored.state.playersData[0].isAI, false);
});
test('房主补齐AI立即恢复断线回合', async t => {
    const env = await environment(t, { reconnectGraceMs: 10000 }); const clients = await table(env); await request(clients[0], 'force_start_game');
    const decision = clients[0].state.decisionId; clients[0].socket.disconnect(); await until(() => clients[1].state.hostSeat === 1);
    assert((await request(clients[1], 'fill_ai_players')).ok); await until(() => clients[1].state.decisionId !== decision);
});
test('迟到操作和重复请求不会重复移动卡牌', async t => {
    const env = await environment(t); const clients = await table(env); await request(clients[0], 'force_start_game');
    const data = moveData(clients[0], { cardId: clients[0].state.playersData[0].hand[0].id });
    const first = await request(clients[0], 'play_card', data); assert(first.ok);
    const before = env.app.rooms.get('TEST').game.version;
    assert.deepEqual(await request(clients[0], 'play_card', data), first); assert.equal(env.app.rooms.get('TEST').game.version, before);
    assert.equal((await request(clients[0], 'play_card', { ...data, actionId: randomUUID() })).code, 'STALE_ACTION');
});
test('真实网络拒绝小数下标和跨席位出牌', async t => {
    const env = await environment(t); const clients = await table(env); await request(clients[0], 'force_start_game');
    const before = clients[0].state.playersData[0].hand;
    assert.equal((await request(clients[0], 'play_card', moveData(clients[0], { cardIndex: 0.5 }))).ok, false);
    assert.equal((await request(clients[1], 'play_card', moveData(clients[1], { cardId: clients[1].state.playersData[1].hand[0].id }))).code, 'WRONG_TURN');
    assert.deepEqual(clients[0].state.playersData[0].hand, before);
});
test('真实网络拒绝整手牌、重复实体与无效吃牌', async t => {
    const env = await environment(t); const clients = await table(env); await request(clients[0], 'force_start_game');
    const game = env.app.rooms.get('TEST').game; configureClaim(game); await until(() => clients[1].state.decisionId === game.decisionId);
    const hand = [...game.players[1].hand];
    for (const cards of [[], hand, [hand[0], hand[0]], [hand[0], game.players[2].hand[0]]]) assert.equal((await request(clients[1], 'claim_peng', moveData(clients[1], { cardIds: cards, faction: '酥酥软软' }))).ok, false);
    assert.equal((await request(clients[1], 'claim_chi', moveData(clients[1], { cardId: hand[0] }))).ok, false);
    assert.deepEqual(game.players[1].hand, hand); game.auditCardCounts();
    assert((await request(clients[1], 'claim_peng', moveData(clients[1], { cardIds: hand.slice(0, 2), faction: '酥酥软软' }))).ok);
    game.auditCardCounts(); assert.equal(game.players[1].hand.length, 2);
});
test('人类行动超时产生真实自动行动', async t => {
    const env = await environment(t, { actionTimeoutMs: 80 }); const clients = await table(env); await request(clients[0], 'force_start_game');
    const decision = clients[0].state.decisionId; await until(() => clients[1].state.gameId === clients[0].state.gameId && clients[1].state.decisionId !== decision); env.app.rooms.get('TEST').game.auditCardCounts();
});
test('重开取消旧行动任务，结算不被计时任务恢复', async t => {
    const env = await environment(t, { aiDelayMs: 80 }); const client = await join(env); await request(client, 'fill_ai_players');
    const game = env.app.rooms.get('TEST').game;
    game.turn = 1; game.gameState = 'PLAYING'; game.changed();
    const previous = game.gameId; assert((await request(client, 'restart_game')).ok); assert.notEqual(game.gameId, previous);
    await delay(130); assert.equal(game.turn, 0); assert.equal(game.players[0].hand.length, 10);
    game.finishGame(0); game.changed(); await delay(130); assert.equal(game.gameState, 'GAME_OVER');
});
test('清空AI在结束后返回完整大厅状态', async t => {
    const env = await environment(t); const client = await join(env); await request(client, 'fill_ai_players');
    assert.equal((await request(client, 'clear_ai_players')).code, 'MATCH_ACTIVE');
    const game = env.app.rooms.get('TEST').game; game.finishGame(0); game.changed();
    assert((await request(client, 'clear_ai_players')).ok); assert.equal(client.state.gameState, 'WAITING_PLAYERS'); assert.equal(game.players.filter(p => p.isAI).length, 0); assert.equal(game.deck.length, 0);
});
test('四客户端通过真实Socket完成对局、结算与重开', async t => {
    const env = await environment(t); const clients = await table(env); await request(clients[0], 'force_start_game');
    const game = env.app.rooms.get('TEST').game;
    let actions = 0;
    while (game.gameState !== 'GAME_OVER' && actions++ < 500) {
        const move = game.automaticAction(); const client = clients[move.seat];
        await until(() => client.state.decisionId === game.decisionId);
        assert((await request(client, move.action, moveData(client, move.data))).ok);
        game.auditCardCounts(); await delay(40);
    }
    assert.equal(game.gameState, 'GAME_OVER'); await until(() => clients.every(c => c.state.gameState === 'GAME_OVER'));
    const old = game.gameId; assert((await request(clients[0], 'restart_game')).ok); await until(() => clients.every(c => c.state.gameId !== old));
    assert(clients.every(c => c.state.result === null)); assert.equal(game.auditCardCounts().total, 124);
});
test('结束后清空AI释放离线代管席位供新玩家加入', async t => {
    const env = await environment(t); const host = await join(env, '房主'); const player = await join(env, '暂时离线');
    await request(host, 'fill_ai_players'); player.socket.disconnect();
    await until(() => host.state.playersData[1].isAI);
    const game = env.app.rooms.get('TEST').game; game.finishGame(0); game.changed();
    assert((await request(host, 'clear_ai_players')).ok);
    const next = await join(env, '新玩家'); assert.equal(next.seat, 1); assert.equal(game.players[1].connected, true);
});
