'use strict';

const { CARD_DB, FACTION_INFO, RELATION_MAP, BASIC_RULES, CLOWN_DESC, matchedFactions, VERSION } = GameRules;
const socket = io({ autoConnect: false });
const $ = id => document.getElementById(id);
let mySeat = -1;
let lastServerState = null;
let currentDecisionStep = 'MAIN';
let selectedCardIds = new Set();
let requestBusy = false;
let joinIntent = sessionStorage.getItem('class4.joined') === 'true';
let dismissedResult = null;
let notificationTimer;
let confirmAction = null;

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}
function notice(message) {
    $('notification').textContent = message;
    $('notification').hidden = false;
    clearTimeout(notificationTimer);
    notificationTimer = setTimeout(() => { $('notification').hidden = true; }, 6000);
}
function connectionStatus(message, offline = false) {
    $('connection-banner').textContent = message;
    $('connection-banner').classList.toggle('offline', offline);
    $('join-btn').disabled = !socket.connected;
    if (offline && mySeat >= 0) $('my-seat-badge').textContent = `P${mySeat} · 连接断开`;
}
async function initializeSession() {
    connectionStatus('正在连接服务器…');
    const response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('服务器暂时无法建立会话。');
    await response.json();
    socket.connect();
}
function emitRequest(event, data = {}) {
    return new Promise(resolve => {
        if (!socket.connected) { notice('连接已断开，请等待重连。'); resolve({ ok: false }); return; }
        socket.timeout(5000).emit(event, data, (error, result) => {
            if (error) { notice('操作确认超时，请检查连接与当前牌局。'); resolve({ ok: false }); return; }
            if (!result.ok) notice(result.message);
            resolve(result);
        });
    });
}
function actionId() { return Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join(''); }
async function gameAction(event, data = {}) {
    if (requestBusy || !lastServerState || mySeat < 0 || !socket.connected) return;
    requestBusy = true;
    const request = { ...data, actionId: actionId(), gameId: lastServerState.gameId, decisionId: lastServerState.decisionId };
    renderCenterActionArea(lastServerState);
    await emitRequest(event, request);
    requestBusy = false;
    if (lastServerState) renderGame(lastServerState);
}
async function joinRoom() {
    const name = $('player-nickname-input').value.trim();
    const roomCode = $('room-code-input').value.trim();
    if (!name) { $('join-error').textContent = '请输入选手昵称。'; return; }
    const result = await emitRequest('join_room', { name, roomCode });
    if (!result.ok) { $('join-error').textContent = result.message || '尚未成功加入房间。'; return; }
    joinIntent = true;
    sessionStorage.setItem('class4.joined', 'true');
    sessionStorage.setItem('class4.name', name);
    sessionStorage.setItem('class4.room', result.roomCode);
    $('join-error').textContent = '';
    $('main-menu-screen').hidden = true;
    $('game-screen').hidden = false;
    connectionStatus('已连接 · 刷新页面可恢复当前席位');
}
function resetSelectionState() { currentDecisionStep = 'MAIN'; selectedCardIds.clear(); }
function createCardElement(card, mini = false, interactive = false) {
    const info = CARD_DB[card.name];
    if (!info) throw new Error('服务器返回了未知人物牌。');
    const node = element(interactive ? 'button' : 'div', `card${mini ? ' mini-card' : ''}${info.isWildcard ? ' card-gold' : ''}`);
    node.style.backgroundImage = `url('/cards-v25/${info.image}.webp')`;
    node.dataset.cardId = card.id;
    node.title = card.name;
    const tags = element('div', 'tag-container');
    if (!mini) for (const faction of info.factions) {
        const tag = element('span', 'f-tag', FACTION_INFO[faction].text);
        tag.style.backgroundColor = FACTION_INFO[faction].color;
        tag.style.clipPath = FACTION_INFO[faction].shape;
        tags.append(tag);
    }
    node.append(tags, element('span', '', card.name));
    if (interactive) {
        node.type = 'button';
        node.setAttribute('aria-label', card.name);
        node.setAttribute('aria-pressed', String(selectedCardIds.has(card.id)));
        node.classList.toggle('card-selected', selectedCardIds.has(card.id));
        node.addEventListener('click', () => onMyHandCardClick(card.id));
        node.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') inspectCard(card.name); });
        node.addEventListener('focus', () => { if (node.matches(':focus-visible')) inspectCard(card.name); });
        node.addEventListener('keydown', event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            const cards = [...$('hand-0').querySelectorAll('button')];
            const index = cards.indexOf(node);
            const next = cards[(index + (event.key === 'ArrowRight' ? 1 : cards.length - 1)) % cards.length];
            next.focus(); event.preventDefault();
        });
    }
    return node;
}
function inspectCard(name) {
    const info = CARD_DB[name];
    $('inspect-title').textContent = `${name}${info.isWildcard ? ' · 宝牌，万能补齐' : ''}`;
    const lines = info.factions.map(f => `${f}（${FACTION_INFO[f].req}张）：${FACTION_INFO[f].desc}`);
    for (const other of info.relations) lines.push(`与${other}：${RELATION_MAP[GameRules.relationKey(name, other)]}`);
    if (info.onPlayDesc) lines.push(info.onPlayDesc);
    if (!lines.length) lines.push('选择该牌后可确认出牌。');
    $('inspect-content').textContent = lines.join('\n');
}
function resetInspector() { $('inspect-title').textContent = '卡牌详情'; $('inspect-content').textContent = '选择、聚焦或悬停手牌可查看说明。'; }
function onMyHandCardClick(id) {
    if (!lastServerState || requestBusy || !socket.connected) return;
    const own = lastServerState.playersData[mySeat].hand;
    const card = own.find(c => c.id === id);
    if (!card) return;
    inspectCard(card.name);
    if (lastServerState.gameState === 'PLAYING' && lastServerState.turn === mySeat) {
        const selected = selectedCardIds.has(id); selectedCardIds.clear(); if (!selected) selectedCardIds.add(id);
    } else if (lastServerState.gameState === 'WAITING_ACTION' && currentDecisionStep === 'PENG_SELECT') {
        if (selectedCardIds.has(id)) selectedCardIds.delete(id);
        else if (selectedCardIds.size < 4) selectedCardIds.add(id);
    } else if (lastServerState.gameState === 'WAITING_ACTION' && currentDecisionStep === 'CHI_SELECT') {
        if (!lastServerState.actionOptions[mySeat].chiOptions.some(option => option.cardId === id)) { notice('这张牌无法与当前弃牌组成关系。'); return; }
        selectedCardIds.clear(); selectedCardIds.add(id);
    }
    renderGame(lastServerState);
    const focus = $('hand-0').querySelector(`[data-card-id="${CSS.escape(id)}"]`);
    if (focus) focus.focus({ preventScroll: true });
}
function renderPlayerArea(relative, data, state) {
    const labels = ['我', '下家', '对家', '上家'];
    const suffix = data.isAI ? ' · AI' : data.connected ? '' : data.reserved ? ' · 断线保留' : ' · 空位';
    $('title-' + relative).textContent = `${labels[relative]} · P${data.seat} ${data.name}${suffix} · ${data.handCount}张${state.hostSeat === data.seat ? ' · 房主' : ''}`;
    $('player-' + relative).classList.toggle('active-player', state.gameState === 'PLAYING' && state.turn === data.seat);
    const status = $('status-' + relative); status.replaceChildren();
    const buffs = data.buffs;
    const tags = [];
    if (buffs.skipTurnCount) tags.push(['negative', `暂停${buffs.skipTurnCount}回合`]);
    if (buffs.immune) tags.push(['positive', '免疫护盾']);
    if (buffs.extraDrawNext) tags.push(['', `下次摸牌+${buffs.extraDrawNext}`]);
    if (buffs.noDrawNext) tags.push(['', '下次不摸牌']);
    if (buffs.extraPlaysNext) tags.push(['positive', `额外出牌${buffs.extraPlaysNext}次`]);
    if (buffs.skipPlayNext) tags.push(['negative', '下次无法出牌']);
    for (const [style, text] of tags) status.append(element('span', `status-tag ${style}`, text));
    const hand = $('hand-' + relative); hand.replaceChildren();
    if (relative === 0) for (const card of data.hand) hand.append(createCardElement(card, false, true));
    else for (let i = 0; i < Math.min(12, data.handCount); i++) hand.append(element('div', 'card card-back'));
    const bonds = $('bond-' + relative); bonds.replaceChildren();
    for (const bond of data.bonds) {
        const group = element('div', 'bond-group');
        const cards = element('div', 'bond-cards');
        for (const card of bond.cards) cards.append(createCardElement(card, true));
        group.append(element('div', 'bond-title', bond.name), cards); bonds.append(group);
    }
    const river = $('river-' + relative); river.replaceChildren(element('span', 'river-label', `${labels[relative]} · ${data.discards.length}张`));
    for (const card of data.discards) river.append(createCardElement(card, true));
}
function actionButton(label, callback, style = '', disabled = false) {
    const button = element('button', `action-btn ${style}`, label);
    button.disabled = disabled || requestBusy || !socket.connected;
    button.addEventListener('click', callback);
    $('decision-buttons').append(button);
    return button;
}
function renderCenterActionArea(state) {
    $('decision-buttons').replaceChildren(); $('pending-card-wrap').replaceChildren();
    $('pending-card-hint').textContent = state.silenceEatPengTurns ? `南模天团封印中 · 剩余${state.silenceEatPengTurns}个行动回合` : '';
    const own = state.playersData[mySeat].hand;
    if (state.gameState === 'WAITING_PLAYERS') {
        $('turn-indicator').textContent = state.hostSeat === mySeat ? '等待朋友加入，或补齐AI开始对局。' : '等待房主开始对局。'; return;
    }
    if (state.gameState === 'GAME_OVER') { $('turn-indicator').textContent = state.result.reason; return; }
    if (state.gameState === 'PLAYING') {
        $('turn-indicator').textContent = state.turn === mySeat ? `轮到你出牌${state.isCurrentTurnExtra ? ' · 追加回合' : ''} · 剩余${state.remainingPlays}次` : `等待P${state.turn}出牌${state.isCurrentTurnExtra ? ' · 追加回合' : ''}`;
        if (state.turn === mySeat) {
            const selected = own.find(card => selectedCardIds.has(card.id));
            actionButton(selected ? `打出【${selected.name}】` : '选择手牌后确认出牌', () => gameAction('play_card', { cardId: selected.id }), 'confirm', !selected);
        }
        return;
    }
    for (const card of state.pendingCards) $('pending-card-wrap').append(createCardElement(card));
    if (state.gameState === 'CLOWN_INTERRUPT') {
        const info = state.clownInterruptInfo;
        $('turn-indicator').textContent = info.interceptorSeat === mySeat ? '小丑二人组 · 是否截取本次羁绊？' : `等待P${info.interceptorSeat}响应反制。`;
        if (info.interceptorSeat === mySeat) {
            actionButton('确认截取并赠予1张手牌', () => gameAction('confirm_clown_interrupt'), 'confirm');
            actionButton('放过(不发动)', () => gameAction('pass_clown_interrupt'), 'pass');
        }
        return;
    }
    const options = state.actionOptions[mySeat];
    if (!options?.canChi && !options?.canPeng) { $('turn-indicator').textContent = '等待下家决定吃碰。'; return; }
    $('turn-indicator').textContent = '可以组成羁绊，请选择操作。';
    if (currentDecisionStep === 'MAIN') {
        if (options.canChi) actionButton('吃 (双人羁绊)', () => { currentDecisionStep = 'CHI_SELECT'; selectedCardIds.clear(); renderGame(state); });
        if (options.canPeng) actionButton('碰 (勾选手牌组合)', () => { currentDecisionStep = 'PENG_SELECT'; selectedCardIds.clear(); renderGame(state); });
        actionButton('过', () => gameAction('claim_pass'), 'pass');
    } else if (currentDecisionStep === 'CHI_SELECT') {
        $('pending-card-hint').textContent = '选择一张关系牌，确认后组成羁绊。';
        for (const option of options.chiOptions) actionButton(`${option.name}：${RELATION_MAP[option.relation]}`, () => { selectedCardIds.clear(); selectedCardIds.add(option.cardId); inspectCard(option.name); renderGame(state); }, `choice${selectedCardIds.has(option.cardId) ? ' active' : ''}`);
        const id = [...selectedCardIds][0];
        actionButton('确认吃牌', () => gameAction('claim_chi', { cardId: id }), 'confirm', !id);
        actionButton('返回', () => { resetSelectionState(); renderGame(state); }, 'btn-back');
    } else {
        const picked = own.filter(card => selectedCardIds.has(card.id));
        $('pending-card-hint').textContent = `已选${picked.length}张：${picked.map(card => card.name).join('、') || '请选择手牌'}\n可选阵营：${options.pengOptions.map(option => `${option.faction}，需${option.reqCardsCount}张手牌`).join('；')}`;
        for (const faction of matchedFactions(picked.map(card => card.name), state.pendingCard)) actionButton(`确认碰牌【${faction}】`, () => gameAction('claim_peng', { cardIds: [...selectedCardIds], faction }), 'confirm');
        actionButton('返回', () => { resetSelectionState(); renderGame(state); }, 'btn-back');
    }
}
function renderGame(state) {
    if (mySeat < 0) return;
    const focusedId = document.activeElement?.dataset.cardId;
    $('room-badge').textContent = `房间 ${state.roomCode}`;
    $('my-seat-badge').textContent = `我的座位 P${mySeat}${state.hostSeat === mySeat ? ' · 房主' : ''}`;
    $('deck-left-badge').textContent = `牌库剩余 ${state.deckCount}`;
    for (let seat = 0; seat < 4; seat++) renderPlayerArea((seat - mySeat + 4) % 4, state.playersData[seat], state);
    const active = ['PLAYING', 'WAITING_ACTION', 'CLOWN_INTERRUPT'].includes(state.gameState);
    for (const button of document.querySelectorAll('[data-host-command]')) button.disabled = !socket.connected || state.hostSeat !== mySeat || (button.id === 'clear-ai-btn' && active);
    renderCenterActionArea(state);
    if (focusedId) {
        const focusedCard = $('hand-0').querySelector(`[data-card-id="${CSS.escape(focusedId)}"]`);
        if (focusedCard) focusedCard.focus({ preventScroll: true });
    }
    if (state.gameState === 'GAME_OVER') {
        $('gameover-title').textContent = state.result.winnerSeat === null ? '本局流局' : state.result.winnerSeat === mySeat ? '🎉 你获胜了' : '本局结束';
        $('gameover-reason-text').textContent = state.result.reason;
        $('again-btn').disabled = state.hostSeat !== mySeat;
        $('again-btn').textContent = state.hostSeat === mySeat ? '🔄 再来一局 (重新开始)' : '等待房主开始下一局';
        if (dismissedResult !== state.gameId && !$('gameover-modal').open) $('gameover-modal').showModal();
    } else if ($('gameover-modal').open) $('gameover-modal').close();
}
function appendLog(data) {
    const row = element('div', 'log-entry', `${data.title}：${data.action}`);
    if (['faction', 'relation', 'system', 'onplay'].includes(data.type)) row.classList.add(data.type);
    const box = $('bond-log-content'); box.append(row);
    while (box.children.length > 150) box.firstElementChild.remove();
    box.scrollTop = box.scrollHeight;
}
function appendChat(data) {
    const row = element('div', 'chat-line');
    row.append(element('span', 'chat-sender', `P${data.seat} ${data.senderName}：`), document.createTextNode(data.text));
    const box = $('chat-messages'); box.append(row);
    while (box.children.length > 100) box.firstElementChild.remove();
    box.scrollTop = box.scrollHeight;
}
function switchEncTab(tab) {
    for (const button of document.querySelectorAll('.enc-tab')) {
        const active = button.dataset.tab === tab;
        button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active));
    }
    const body = $('enc-cards-list'); body.replaceChildren();
    const items = tab === 'FACTION' ? Object.entries(FACTION_INFO).map(([name, data]) => [name + ` · ${data.req}张`, data.desc])
        : tab === 'RELATION' ? [...Object.entries(RELATION_MAP), ['小丑二人组 · 特殊反制', CLOWN_DESC]]
        : Object.entries(CARD_DB).map(([name, data]) => [name, `所属阵营：${data.factions.join('、') || '无固定阵营'}\n关系人物：${data.relations.join('、') || '无双人关系'}${data.isWildcard ? '\n宝牌：可以补齐任意阵营，打出时不可被吃碰。' : ''}${data.onPlayDesc ? '\n' + data.onPlayDesc : ''}`]);
    for (const [title, description] of items) {
        const card = element('article', 'enc-card');
        card.append(element('div', 'enc-card-title', title), element('p', 'enc-card-desc', description)); body.append(card);
    }
}
function openEncyclopedia() { switchEncTab('FACTION'); $('encyclopedia-modal').showModal(); }
function confirmCommand(title, description, callback) {
    $('confirm-title').textContent = title; $('confirm-description').textContent = description;
    confirmAction = callback; $('confirm-modal').showModal();
}
async function triggerRestartGame() { await emitRequest('restart_game'); }

socket.on('connect', () => { connectionStatus('服务器已连接'); if (joinIntent) joinRoom(); });
socket.on('disconnect', () => { requestBusy = false; resetSelectionState(); connectionStatus('连接已断开，正在恢复连接。席位暂时保留。', true); if (lastServerState) renderCenterActionArea(lastServerState); });
socket.on('connect_error', error => { connectionStatus('连接失败，请检查服务并点击重新连接。', true); $('join-error').textContent = error.message; });
socket.on('session_replaced', () => { joinIntent = false; notice('该席位已在另一个页面打开。'); socket.disconnect(); });
socket.on('seat_assigned', data => { mySeat = data.seat; });
socket.on('room_full', () => { $('join-error').textContent = '房间已满，请使用其他房间代码。'; });
socket.on('action_rejected', data => notice(data.message));
socket.on('sync_game_state', state => {
    if (state.decisionId !== lastServerState?.decisionId || state.gameId !== lastServerState?.gameId) resetSelectionState();
    if (state.gameId !== lastServerState?.gameId) { dismissedResult = null; resetInspector(); }
    lastServerState = state; renderGame(state);
});
socket.on('room_history', data => { $('bond-log-content').replaceChildren(); $('chat-messages').replaceChildren(); data.logs.forEach(appendLog); data.chat.forEach(appendChat); });
socket.on('match_started', () => { $('bond-log-content').replaceChildren(); resetSelectionState(); if ($('reveal-modal').open) $('reveal-modal').close(); });
socket.on('broadcast_log', appendLog);
socket.on('new_chat_message', appendChat);
socket.on('reveal_hands', data => { $('reveal-content').textContent = `P${data.targetSeat} ${data.targetName}\n${data.cards.join('、')}`; if (!$('reveal-modal').open) $('reveal-modal').showModal(); });
socket.on('play_fx', data => {
    if (data.type === 'splash') {
        $('splash-text').textContent = data.text; $('splash-text').classList.remove('splash-active');
        void $('splash-text').offsetWidth; $('splash-text').classList.add('splash-active');
    }
});
$('player-nickname-input').value = sessionStorage.getItem('class4.name') || '';
$('room-code-input').value = sessionStorage.getItem('class4.room') || 'CLASS4';
$('join-form').addEventListener('submit', event => { event.preventDefault(); joinRoom(); });
$('reconnect-btn').addEventListener('click', () => { socket.disconnect(); initializeSession(); });
$('encyclopedia-btn').addEventListener('click', openEncyclopedia);
for (const button of document.querySelectorAll('.enc-tab')) button.addEventListener('click', () => switchEncTab(button.dataset.tab));
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(button.dataset.close).close());
for (const button of document.querySelectorAll('[data-host-command]')) button.addEventListener('click', () => {
    const command = button.dataset.hostCommand;
    if ((command === 'restart_game' || command === 'force_start_game') && lastServerState && ['PLAYING', 'WAITING_ACTION', 'CLOWN_INTERRUPT'].includes(lastServerState.gameState)) confirmCommand('重新开始对局', '当前对局将结束，全员重新发牌。', () => emitRequest(command));
    else emitRequest(command);
});
for (const id of ['rules-btn', 'menu-rules-btn']) $(id).addEventListener('click', () => $('rules-modal').showModal());
for (const text of BASIC_RULES) $('rules-list').append(element('li', '', text));
$('clown-rules').textContent = `小丑二人组：${CLOWN_DESC}`;
$('build-version').textContent = VERSION;
$('rename-btn').addEventListener('click', () => { $('new-name-input').value = lastServerState.playersData[mySeat].name; $('name-modal').showModal(); });
$('name-form').addEventListener('submit', async event => {
    event.preventDefault(); const name = $('new-name-input').value.trim();
    const result = await emitRequest('update_name', { name });
    if (result.ok) { sessionStorage.setItem('class4.name', name); $('player-nickname-input').value = name; $('name-modal').close(); }
});
$('chat-input-row').addEventListener('submit', async event => {
    event.preventDefault(); const text = $('chat-input').value.trim(); if (!text) return;
    const result = await emitRequest('send_chat', { text }); if (result.ok) $('chat-input').value = '';
});
$('chat-header').addEventListener('click', () => {
    $('chat-content').hidden = !$('chat-content').hidden;
    $('chat-header').setAttribute('aria-expanded', String(!$('chat-content').hidden));
    $('chat-toggle-icon').textContent = $('chat-content').hidden ? '▲' : '▼';
});
$('again-btn').addEventListener('click', triggerRestartGame);
$('view-board-btn').addEventListener('click', () => { dismissedResult = lastServerState.gameId; $('gameover-modal').close(); });
$('gameover-modal').addEventListener('cancel', () => { dismissedResult = lastServerState.gameId; });
$('confirm-action-btn').addEventListener('click', () => { $('confirm-modal').close(); if (confirmAction) { const action = confirmAction; confirmAction = null; action(); } });
$('leave-btn').addEventListener('click', () => confirmCommand('离开房间', '离开后释放席位，对局进行中由AI接替。', async () => {
    const result = await emitRequest('leave_room');
    if (result.ok) {
        joinIntent = false; sessionStorage.setItem('class4.joined', 'false'); mySeat = -1; lastServerState = null;
        $('game-screen').hidden = true; $('main-menu-screen').hidden = false;
        for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    }
}));
setInterval(() => {
    const deadline = lastServerState?.deadlineAt;
    $('countdown').textContent = deadline ? `本次行动剩余 ${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))} 秒` : '';
}, 250);
window.addEventListener('unhandledrejection', () => connectionStatus('连接或页面执行失败，请检查服务器后重新连接。', true));
initializeSession();
