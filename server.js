'use strict';

const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Server } = require('socket.io');
const cookie = require('cookie');
const { GameEngine } = require('./game');
const { VERSION } = require('./public/rules');

const COOKIE_NAME = 'class4_session';
const GAME_ACTIONS = ['play_card', 'claim_peng', 'claim_chi', 'claim_pass', 'confirm_clown_interrupt', 'pass_clown_interrupt'];
const fail = (code, message) => ({ ok: false, code, message });
const validText = (value, max) => typeof value === 'string' && value.trim().length > 0 && Array.from(value.trim()).length <= max && !/[\u0000-\u001f\u007f]/u.test(value);

function createApplication(options = {}) {
    const settings = { aiDelayMs: 700, actionTimeoutMs: 45000, reconnectGraceMs: 15000, idleRoomMs: 1800000, ...options };
    for (const value of Object.values(settings)) if (!Number.isInteger(value) || value < 1) throw new Error('服务时间设置必须为正整数。');
    const app = express();
    const server = http.createServer(app);
    const sessions = new Map();
    const rooms = new Map();
    let stopped = false;
    app.disable('x-powered-by');
    app.set('trust proxy', 'loopback');
    app.use((req, res, next) => {
        res.set({
            'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
            'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin'
        });
        next();
    });
    app.get('/healthz', (req, res) => res.set('Cache-Control', 'no-store').json({ status: 'ok', version: VERSION, rooms: rooms.size }));
    app.get('/api/session', (req, res) => {
        const token = cookie.parse(req.headers.cookie || '')[COOKIE_NAME];
        let session = sessions.get(token);
        if (!session) {
            if (sessions.size >= 2048) return res.status(503).json(fail('BUSY', '服务繁忙，请稍后连接。'));
            const id = randomBytes(32).toString('hex');
            session = { id, roomCode: null, seat: null, touched: Date.now(), actions: new Map() };
            sessions.set(id, session);
        }
        session.touched = Date.now();
        res.cookie(COOKIE_NAME, session.id, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: 86400000, path: '/' });
        res.set('Cache-Control', 'no-store').json({ ok: true, version: VERSION });
    });
    app.get('/multiplayer.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
    app.use(express.static(path.join(__dirname, 'public'), {
        setHeaders(res, filename) {
            res.setHeader('Cache-Control', filename.includes(`${path.sep}cards-v25${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
        }
    }));
    const io = new Server(server, {
        maxHttpBufferSize: 16384, pingInterval: 10000, pingTimeout: 10000,
        allowRequest(req, callback) {
            const origin = req.headers.origin;
            callback(null, !origin || origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`);
        }
    });
    io.use((socket, next) => {
        const id = cookie.parse(socket.request.headers.cookie || '')[COOKIE_NAME];
        const session = sessions.get(id);
        if (!session) return next(new Error('请刷新页面以建立会话。'));
        socket.data.session = session;
        socket.data.rate = new Map();
        next();
    });
    function response(socket, ack, result) {
        if (typeof ack === 'function') ack(result);
        if (!result.ok) socket.emit('action_rejected', result);
    }
    function limited(socket, name, count, interval) {
        const now = Date.now();
        const history = (socket.data.rate.get(name) || []).filter(time => now - time < interval);
        if (history.length >= count) return true;
        history.push(now); socket.data.rate.set(name, history);
        return false;
    }
    function assignHost(room) {
        if (room.hostSeat !== null && room.game.players[room.hostSeat].connected && !room.game.players[room.hostSeat].isAI) return;
        const player = room.game.players.find(p => p.connected && !p.isAI);
        room.hostSeat = player ? player.seat : null;
    }
    function broadcast(room) {
        if (stopped) return;
        assignHost(room);
        schedule(room);
        for (const player of room.game.players) {
            if (!player.connected || !player.socketId) continue;
            room.touched = Date.now();
            io.to(player.socketId).emit('sync_game_state', {
                ...room.game.snapshot(player.seat), roomCode: room.code, hostSeat: room.hostSeat,
                deadlineAt: room.deadlineAt, buildVersion: VERSION
            });
        }
    }
    function schedule(room) {
        const seat = room.game.actingSeat();
        const automated = seat !== null && room.game.players[seat].isAI;
        const key = `${room.game.decisionId}:${seat}:${automated}`;
        if (room.timerKey === key) return;
        clearTimeout(room.timer);
        room.timer = null; room.timerKey = key; room.deadlineAt = null;
        if (seat === null) return;
        const duration = automated ? settings.aiDelayMs : settings.actionTimeoutMs;
        room.deadlineAt = Date.now() + duration;
        const gameId = room.game.gameId;
        const decisionId = room.game.decisionId;
        room.timer = setTimeout(() => {
            if (room.game.gameId !== gameId || room.game.decisionId !== decisionId || room.game.actingSeat() !== seat) return;
            const move = room.game.automaticAction(!automated);
            if (move) {
                const result = room.game.act(move.seat, move.action, move.data);
                if (!result.ok) throw new Error(`自动行动无效：${result.code}`);
            }
        }, duration);
        room.timer.unref();
    }
    function createRoom(code) {
        const room = { code, game: new GameEngine(), hostSeat: null, timer: null, timerKey: null, deadlineAt: null, disconnectTimers: new Map(), chat: [], touched: Date.now() };
        room.game.on('change', () => broadcast(room));
        room.game.on('match_started', data => io.to(code).emit('match_started', data));
        room.game.on('log', data => io.to(code).emit('broadcast_log', data));
        room.game.on('fx', data => io.to(code).emit('play_fx', data));
        room.game.on('private', (seat, event, data) => {
            const player = room.game.players[seat];
            if (player.connected && player.socketId) io.to(player.socketId).emit(event, data);
        });
        rooms.set(code, room);
        return room;
    }
    function membership(socket) {
        const session = socket.data.session;
        const room = rooms.get(session.roomCode);
        if (!room || session.seat === null) return null;
        const player = room.game.players[session.seat];
        return player.ownerId === session.id && player.socketId === socket.id ? { room, player, session } : null;
    }
    function fillAI(room) {
        for (const player of room.game.players) {
            if (!player.connected) {
                player.isAI = true;
                if (!player.ownerId) player.name = `AI电脑-${player.seat}号`;
            }
        }
    }
    io.on('connection', socket => {
        socket.on('join_room', (data, ack) => {
            if (limited(socket, 'join', 10, 10000)) return response(socket, ack, fail('RATE_LIMIT', '连接操作过于频繁。'));
            if (!data || typeof data.roomCode !== 'string' || !/^[a-zA-Z0-9_-]{1,16}$/.test(data.roomCode) || !validText(data.name, 10)) return response(socket, ack, fail('INVALID_INPUT', '请输入1至10个字符的昵称，以及英文或数字房间代码。'));
            const code = data.roomCode.toUpperCase();
            const session = socket.data.session;
            if (session.roomCode && session.roomCode !== code && rooms.has(session.roomCode)) return response(socket, ack, fail('ALREADY_JOINED', '请返回原房间离开座位后再加入其他房间。'));
            if (!rooms.has(code) && rooms.size >= 64) return response(socket, ack, fail('BUSY', '房间数量已达上限。'));
            const room = rooms.get(code) || createRoom(code);
            let player = room.game.players.find(p => p.ownerId === session.id);
            if (!player) player = room.game.players.find(p => !p.ownerId && !p.connected);
            if (!player) {
                socket.emit('room_full');
                return response(socket, ack, fail('ROOM_FULL', '房间已满，请使用其他房间代码。'));
            }
            clearTimeout(room.disconnectTimers.get(player.seat));
            room.disconnectTimers.delete(player.seat);
            const previousSocket = player.socketId && io.sockets.sockets.get(player.socketId);
            player.ownerId = session.id; player.socketId = socket.id;
            player.connected = true; player.isAI = false;
            player.name = data.name.trim();
            session.roomCode = code; session.seat = player.seat; session.touched = Date.now();
            if (previousSocket && previousSocket !== socket) { previousSocket.emit('session_replaced'); previousSocket.disconnect(true); }
            socket.join(code);
            socket.emit('seat_assigned', { seat: player.seat, roomCode: code });
            socket.emit('room_history', { logs: room.game.logs, chat: room.chat });
            broadcast(room);
            response(socket, ack, { ok: true, seat: player.seat, roomCode: code });
        });
        socket.on('leave_room', (data, ack) => {
            const member = membership(socket);
            if (!member) return response(socket, ack, fail('NOT_JOINED', '当前没有加入房间。'));
            const { room, player, session } = member;
            player.connected = false; player.socketId = null; player.ownerId = null;
            player.isAI = ['PLAYING', 'WAITING_ACTION', 'CLOWN_INTERRUPT'].includes(room.game.gameState);
            player.name = player.isAI ? `AI电脑-${player.seat}号` : `玩家 ${player.seat}`;
            socket.leave(room.code); session.roomCode = null; session.seat = null; session.actions.clear();
            broadcast(room);
            response(socket, ack, { ok: true });
        });
        socket.on('update_name', (data, ack) => {
            const member = membership(socket);
            if (!member) return response(socket, ack, fail('NOT_JOINED', '请先加入房间。'));
            if (limited(socket, 'name', 4, 10000)) return response(socket, ack, fail('RATE_LIMIT', '改名操作过于频繁。'));
            if (!data || !validText(data.name, 10)) return response(socket, ack, fail('INVALID_NAME', '昵称需要1至10个字符。'));
            member.player.name = data.name.trim();
            broadcast(member.room); response(socket, ack, { ok: true });
        });
        socket.on('send_chat', (data, ack) => {
            const member = membership(socket);
            if (!member) return response(socket, ack, fail('NOT_JOINED', '请先加入房间。'));
            if (limited(socket, 'chat', 5, 5000)) return response(socket, ack, fail('RATE_LIMIT', '请稍后发送消息。'));
            if (!data || !validText(data.text, 80)) return response(socket, ack, fail('INVALID_CHAT', '消息需要1至80个字符。'));
            const message = { seat: member.player.seat, senderName: member.player.name, text: data.text.trim(), time: new Date().toISOString() };
            member.room.chat.push(message);
            if (member.room.chat.length > 100) member.room.chat.shift();
            io.to(member.room.code).emit('new_chat_message', message);
            response(socket, ack, { ok: true });
        });
        for (const action of GAME_ACTIONS) socket.on(action, (data, ack) => {
            const member = membership(socket);
            if (!member) return response(socket, ack, fail('NOT_JOINED', '请先加入房间。'));
            if (limited(socket, 'move', 30, 1000)) return response(socket, ack, fail('RATE_LIMIT', '操作过于频繁。'));
            if (!data || typeof data.actionId !== 'string' || data.actionId.length > 80 || data.actionId.length < 8) return response(socket, ack, fail('INVALID_INPUT', '操作编号无效。'));
            const previous = member.session.actions.get(data.actionId);
            if (previous) return response(socket, ack, previous);
            const game = member.room.game;
            if (data.gameId !== game.gameId || data.decisionId !== game.decisionId) return response(socket, ack, fail('STALE_ACTION', '对局状态已经更新，请重新选择操作。'));
            const result = game.act(member.player.seat, action, data);
            member.session.actions.set(data.actionId, result);
            if (member.session.actions.size > 128) member.session.actions.delete(member.session.actions.keys().next().value);
            response(socket, ack, result);
        });
        for (const command of ['restart_game', 'force_start_game', 'fill_ai_players', 'clear_ai_players']) socket.on(command, (data, ack) => {
            const member = membership(socket);
            if (!member) return response(socket, ack, fail('NOT_JOINED', '请先加入房间。'));
            if (member.room.hostSeat !== member.player.seat) return response(socket, ack, fail('HOST_ONLY', '该操作由房主执行。'));
            if (limited(socket, 'control', 4, 2000)) return response(socket, ack, fail('RATE_LIMIT', '房间操作过于频繁。'));
            const { room } = member;
            if (command === 'clear_ai_players') {
                if (['PLAYING', 'WAITING_ACTION', 'CLOWN_INTERRUPT'].includes(room.game.gameState)) return response(socket, ack, fail('MATCH_ACTIVE', '请在对局结束后清空AI。'));
                for (const player of room.game.players) if (player.isAI) {
                    const owner = sessions.get(player.ownerId);
                    if (owner) { owner.roomCode = null; owner.seat = null; owner.actions.clear(); }
                    clearTimeout(room.disconnectTimers.get(player.seat)); room.disconnectTimers.delete(player.seat);
                    player.ownerId = null; player.socketId = null; player.connected = false;
                    player.isAI = false; player.name = `玩家 ${player.seat}`;
                }
                for (const session of sessions.values()) if (session.roomCode === room.code) session.actions.clear();
                room.game.returnToLobby();
                return response(socket, ack, { ok: true });
            }
            if (command === 'fill_ai_players' || command === 'force_start_game') fillAI(room);
            if (command === 'fill_ai_players' && room.game.gameState !== 'WAITING_PLAYERS') {
                broadcast(room); return response(socket, ack, { ok: true });
            }
            const result = room.game.startGame();
            if (result.ok) for (const session of sessions.values()) if (session.roomCode === room.code) session.actions.clear();
            response(socket, ack, result);
        });
        socket.on('disconnect', () => {
            if (stopped) return;
            const member = membership(socket);
            if (!member) return;
            const { room, player, session } = member;
            player.connected = false; player.socketId = null; session.touched = Date.now();
            const timer = setTimeout(() => {
                room.disconnectTimers.delete(player.seat);
                if (player.connected || player.ownerId !== session.id) return;
                if (['PLAYING', 'WAITING_ACTION', 'CLOWN_INTERRUPT'].includes(room.game.gameState)) player.isAI = true;
                broadcast(room);
            }, settings.reconnectGraceMs);
            timer.unref(); room.disconnectTimers.set(player.seat, timer);
            broadcast(room);
        });
    });
    const cleanup = setInterval(() => {
        for (const [code, room] of rooms) {
            if (room.game.players.some(p => p.connected) || Date.now() - room.touched < settings.idleRoomMs) continue;
            clearTimeout(room.timer); for (const timer of room.disconnectTimers.values()) clearTimeout(timer);
            rooms.delete(code);
            for (const session of sessions.values()) if (session.roomCode === code) { session.roomCode = null; session.seat = null; }
        }
        for (const [id, session] of sessions) if (!session.roomCode && Date.now() - session.touched > 86400000) sessions.delete(id);
    }, 60000);
    cleanup.unref();
    return {
        app, server, io, rooms,
        listen(port = 3000, host = '0.0.0.0') { return new Promise(resolve => server.listen(port, host, () => resolve(server.address()))); },
        close() {
            stopped = true;
            clearInterval(cleanup);
            for (const room of rooms.values()) { clearTimeout(room.timer); for (const timer of room.disconnectTimers.values()) clearTimeout(timer); }
            return new Promise(resolve => io.close(resolve));
        }
    };
}

if (require.main === module) {
    const port = Number(process.env.PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是1至65535之间的整数。');
    const application = createApplication();
    application.listen(port).then(() => {
        console.log(`四班抽象之奕 ${VERSION}`);
        console.log(`游戏入口：http://localhost:${port}`);
        console.log('同一房间代码即可加入同一场对局。按 Ctrl+C 关闭本服务。');
    });
    let closing = false;
    const close = () => { if (!closing) { closing = true; application.close().then(() => process.exit(0)); } };
    process.on('SIGINT', close); process.on('SIGTERM', close);
}
module.exports = { createApplication };
