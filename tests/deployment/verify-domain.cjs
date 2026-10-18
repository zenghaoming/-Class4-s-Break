'use strict';

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const projectRequire = createRequire(path.join(process.cwd(), 'package.json'));
const { io } = projectRequire('socket.io-client');
const cookie = projectRequire('cookie');
const expectedVersion = projectRequire('./package.json').version;

const origin = new URL(process.argv[2]);
assert.equal(origin.protocol, 'https:');
const roomCode = 'DNS' + randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
const clients = [];
const report = { url: origin.origin, checkedUtc: new Date().toISOString(), roomCode, checks: [] };

async function until(predicate) {
    const deadline = Date.now() + 20000;
    while (!predicate() && Date.now() < deadline) await delay(50);
    assert(predicate(), '等待公网事件超过期限');
}

async function get(route) {
    return fetch(new URL(route, origin), { signal: AbortSignal.timeout(20000) });
}

async function request(client, event, data = {}) {
    const response = await client.socket.timeout(10000).emitWithAck(event, data);
    assert.equal(response.ok, true, JSON.stringify(response));
    return response;
}

async function connect(name, existingCookie) {
    let header = existingCookie;
    if (!header) {
        const session = await get('/api/session');
        assert.equal(session.status, 200);
        const sessionCookie = session.headers.getSetCookie()[0];
        assert(sessionCookie.includes('HttpOnly'));
        assert(sessionCookie.includes('Secure'));
        assert(sessionCookie.includes('SameSite=Strict'));
        const sessionId = cookie.parse(sessionCookie).class4_session;
        assert.equal(typeof sessionId, 'string');
        header = cookie.serialize('class4_session', sessionId);
    }
    const socket = io(origin.origin, {
        transports: ['websocket'],
        extraHeaders: { Cookie: header, Origin: origin.origin },
        autoConnect: false,
        reconnection: false,
        timeout: 15000,
    });
    const client = { socket, header, name, state: null, seat: null };
    clients.push(client);
    socket.on('sync_game_state', state => { client.state = state; });
    await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
        socket.connect();
    });
    const joined = await request(client, 'join_room', { name, roomCode });
    client.seat = joined.seat;
    await until(() => client.state !== null);
    assert.equal(socket.io.engine.transport.name, 'websocket');
    return client;
}

async function main() {
    const plainOrigin = new URL(origin);
    plainOrigin.protocol = 'http:';
    const redirect = await fetch(plainOrigin, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
    assert([301, 302, 307, 308].includes(redirect.status));
    assert.equal(new URL(redirect.headers.get('location'), plainOrigin).href, origin.href);
    report.checks.push('HTTP 自动跳转到 HTTPS');

    const health = await get('/healthz');
    assert.equal(health.status, 200);
    report.health = await health.json();
    assert.equal(report.health.version, expectedVersion);
    report.checks.push('HTTPS 健康检查');

    for (const route of ['/', '/index.html', '/app.js', '/rules.js', '/styles.css']) {
        const response = await get(route);
        assert.equal(response.status, 200, route);
        const bytes = Buffer.from(await response.arrayBuffer());
        const expected = readFileSync(path.join(process.cwd(), 'public', route === '/' ? 'index.html' : route.slice(1)));
        assert.deepEqual(bytes, expected, route);
        if (route === '/index.html') report.htmlSha256 = createHash('sha256').update(bytes).digest('hex');
    }
    const socketScript = await get('/socket.io/socket.io.js');
    assert.equal(socketScript.status, 200);
    for (const route of ['/server.js', '/game.js', '/package.json', '/deploy/cloudflare.yml']) {
        assert.equal((await get(route)).status, 404, route);
    }
    report.checks.push('页面和资源内容一致', '服务器源码及隧道配置隔离');

    try {
        const players = [];
        for (let index = 0; index < 4; index++) players.push(await connect(`域名验证${index}`));
        assert.deepEqual(players.map(client => client.seat), [0, 1, 2, 3]);
        await request(players[0], 'force_start_game');
        await until(() => players.every(client => client.state.gameState === 'PLAYING'));
        const gameId = players[0].state.gameId;
        for (const client of players) {
            assert.equal(client.state.gameId, gameId);
            assert.equal(client.state.deckCount, 87);
            assert(client.state.playersData[client.seat].hand.length >= 9);
            for (const player of client.state.playersData) {
                if (player.seat !== client.seat) {
                    assert.equal(Object.hasOwn(player, 'hand'), false);
                    assert.equal(Object.hasOwn(player, 'ownerId'), false);
                }
            }
        }
        report.checks.push('四个独立 HTTPS 会话', '四客户端 WSS 连接', '四人开局和隐藏手牌隔离');
        const previousVersion = players[0].state.version;
        await request(players[0], 'play_card', {
            cardId: players[0].state.playersData[0].hand[0].id,
            gameId,
            decisionId: players[0].state.decisionId,
            actionId: randomUUID(),
        });
        await until(() => players.every(client => client.state.version > previousVersion));
        report.checks.push('出牌状态同步');

        const returning = players[0];
        returning.socket.disconnect();
        await until(() => players[1].state.playersData[0].connected === false);
        const restored = await connect(returning.name, returning.header);
        assert.equal(restored.seat, 0);
        assert.equal(restored.state.gameId, gameId);
        report.checks.push('断线后恢复原房间和席位');
        report.status = 'passed';
    } finally {
        for (const client of clients) {
            if (client.socket.connected && client.seat !== null) await request(client, 'leave_room');
            client.socket.disconnect();
        }
    }
    console.log(JSON.stringify(report));
}

main();
