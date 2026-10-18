'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { io } = require('socket.io-client');
const cookie = require('cookie');
const { createApplication } = require('../server');

async function environment(t, settings = {}) {
    const app = createApplication(settings);
    const address = await app.listen(0, '127.0.0.1');
    const origin = `http://127.0.0.1:${address.port}`;
    const sockets = [];
    t.after(async () => { for (const socket of sockets) socket.disconnect(); await app.close(); });
    return {
        app, origin, port: address.port,
        async session() {
            const response = await fetch(origin + '/api/session');
            assert.equal(response.status, 200);
            return cookie.serialize('class4_session', cookie.parse(response.headers.getSetCookie()[0]).class4_session);
        },
        async connect(header) {
            const socket = io(origin, { transports: ['websocket'], extraHeaders: { Cookie: header, Origin: origin }, autoConnect: false, reconnection: false, timeout: 3000 });
            sockets.push(socket);
            const result = await new Promise(resolve => {
                socket.once('connect', () => resolve({ accepted: true }));
                socket.once('connect_error', error => resolve({ accepted: false, message: error.message }));
                socket.connect();
            });
            return { socket, ...result };
        },
    };
}

async function until(predicate) {
    const deadline = Date.now() + 3000;
    while (!predicate() && Date.now() < deadline) await delay(10);
    assert(predicate(), '连接状态未在期限内更新。');
}

test('HTTP 请求超额返回退避时间，时间窗口结束后恢复', async t => {
    const env = await environment(t, { perIpHttpLimit: 2, rateWindowMs: 1000 });
    for (let index = 0; index < 2; index++) assert.equal((await fetch(env.origin)).status, 200);
    const rejected = await fetch(env.origin);
    assert.equal(rejected.status, 429);
    assert(Number(rejected.headers.get('retry-after')) > 0);
    assert.equal((await rejected.json()).code, 'RATE_LIMIT');
    assert.equal((await fetch(env.origin + '/healthz')).status, 200);
    await delay(1100);
    assert.equal((await fetch(env.origin)).status, 200);
});

test('全局请求配额独立于来源配额生效', async t => {
    const env = await environment(t, { globalHttpLimit: 2, perIpHttpLimit: 100 });
    for (let index = 0; index < 2; index++) assert.equal((await fetch(env.origin)).status, 200);
    const rejected = await fetch(env.origin);
    assert.equal(rejected.status, 429);
    assert(rejected.headers.get('ratelimit-policy').includes('global-http'));
});

test('会话申请限制生效，既有会话在总配额满时仍可使用', async t => {
    const env = await environment(t, { maxSessions: 2, perIpSessionLimit: 4 });
    const first = await env.session();
    await env.session();
    assert.equal((await fetch(env.origin + '/api/session')).status, 503);
    assert.equal((await fetch(env.origin + '/api/session', { headers: { Cookie: first } })).status, 200);
    assert.equal((await fetch(env.origin + '/api/session')).status, 429);
});

test('同一会话的连接配额在断开和重连后正确释放', async t => {
    const env = await environment(t);
    const header = await env.session();
    const first = await env.connect(header);
    const second = await env.connect(header);
    assert(first.accepted && second.accepted);
    const rejected = await env.connect(header);
    assert.equal(rejected.accepted, false);
    assert(rejected.message.includes('连接过多'));
    first.socket.disconnect();
    await until(() => env.app.io.sockets.sockets.size === 1);
    const replacement = await env.connect(header);
    assert.equal(replacement.accepted, true);
    await delay(40);
    assert.equal((await env.connect(header)).accepted, false);
});

test('并行连接不能超过服务器的连接配额，释放后可以重新连接', async t => {
    const env = await environment(t, { maxSocketConnections: 2, maxSocketsPerSession: 16 });
    const header = await env.session();
    const clients = await Promise.all(Array.from({ length: 8 }, () => env.connect(header)));
    assert.equal(clients.filter(client => client.accepted).length, 2);
    assert.equal(env.app.io.sockets.sockets.size, 2);
    const accepted = clients.find(client => client.accepted);
    accepted.socket.disconnect();
    await until(() => env.app.io.engine.clientsCount < 2);
    assert.equal((await env.connect(header)).accepted, true);
});

test('大量未定义事件会断开连接，并释放会话配额', async t => {
    const env = await environment(t, { packetLimit: 3, maxSocketsPerSession: 1 });
    const header = await env.session();
    const client = await env.connect(header);
    assert.equal(client.accepted, true);
    const disconnected = once(client.socket, 'disconnect', { signal: AbortSignal.timeout(3000) });
    for (let index = 0; index < 4; index++) client.socket.emit('unknown_event', { index });
    await disconnected;
    assert.equal((await env.connect(header)).accepted, true);
});

test('所有真人明确离开后立即释放房间配额', async t => {
    const env = await environment(t, { maxRooms: 1 });
    const first = await env.connect(await env.session());
    const second = await env.connect(await env.session());
    const request = (client, event, data) => client.socket.timeout(3000).emitWithAck(event, data);
    assert.equal((await request(first, 'join_room', { name: '玩家甲', roomCode: 'ROOM_A' })).ok, true);
    assert.equal((await request(second, 'join_room', { name: '玩家乙', roomCode: 'ROOM_B' })).code, 'BUSY');
    assert.equal((await request(first, 'leave_room', {})).ok, true);
    await until(() => env.app.rooms.size === 0);
    assert.equal((await request(second, 'join_room', { name: '玩家乙', roomCode: 'ROOM_B' })).ok, true);
});

test('原始 TCP 连接总量受到限制', async t => {
    const env = await environment(t, { maxHttpConnections: 2 });
    const sockets = [];
    t.after(() => { for (const socket of sockets) socket.destroy(); });
    for (let index = 0; index < 2; index++) {
        const socket = net.createConnection({ host: '127.0.0.1', port: env.port });
        sockets.push(socket);
        await once(socket, 'connect', { signal: AbortSignal.timeout(3000) });
    }
    const extra = net.createConnection({ host: '127.0.0.1', port: env.port });
    sockets.push(extra);
    await once(extra, 'close', { signal: AbortSignal.timeout(3000) });
    const connections = await new Promise(resolve => env.app.server.getConnections((error, count) => { assert.ifError(error); resolve(count); }));
    assert.equal(connections, 2);
    for (const socket of sockets) socket.destroy();
});
