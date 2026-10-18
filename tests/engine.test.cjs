'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GameEngine, isPrime } = require('../game');
const { CARD_DB, FACTION_INFO, RELATION_MAP, relationKey, matchedFactions } = require('../public/rules');

function scenario(hands = [['侯俊贤'], ['戴宇豪'], ['顾忻乐'], ['彭籽稼']], pending = null, fromPlayer = 3, nextDraws = []) {
    const game = new GameEngine();
    game.players.forEach(p => { p.connected = true; });
    assert.equal(game.startGame().ok, true);
    const pool = [...game.registry.keys()];
    const take = name => {
        const index = pool.findIndex(id => game.name(id) === name);
        assert(index >= 0, name);
        return pool.splice(index, 1)[0];
    };
    game.players.forEach((p, index) => { p.hand = hands[index].map(take); p.bonds = []; p.discards = []; });
    game.pendingCardInfo = pending ? { card: pending, rawCard: pending, cards: [take(pending)], fromPlayer, isHatCombo: false, unclaimable: false } : null;
    const draws = nextDraws.map(take);
    game.deck = [...pool, ...draws.reverse()];
    game.turn = pending ? fromPlayer : 0;
    game.gameState = pending ? 'WAITING_ACTION' : 'PLAYING';
    game.logs = [];
    game.auditCardCounts();
    return game;
}
const idOf = (game, seat, name) => game.players[seat].hand.find(id => game.name(id) === name);
const ownNames = (game, seat) => game.players[seat].hand.map(id => game.name(id));
const stateText = game => JSON.stringify({ deck: game.deck, players: game.players, buffs: game.buffs, state: game.gameState, turn: game.turn, pending: game.pendingCardInfo, logs: game.logs });
function legal(game, seat, action, data) { assert.equal(game.act(seat, action, data).ok, true); game.auditCardCounts(); }

test('31种人物、10个阵营和关系说明完整', () => {
    assert.equal(Object.keys(CARD_DB).length, 31); assert.equal(Object.keys(FACTION_INFO).length, 10);
    for (const [name, card] of Object.entries(CARD_DB)) {
        for (const other of card.relations) { assert(CARD_DB[other].relations.includes(name)); assert(RELATION_MAP[relationKey(name, other)]); }
        for (const faction of card.factions) assert(FACTION_INFO[faction]);
    }
});
test('开局发牌与每种4张守恒', () => {
    const game = new GameEngine(); game.players.forEach(p => { p.connected = true; }); game.startGame();
    assert.deepEqual(game.players.map(p => p.hand.length), [10, 9, 9, 9]); assert.equal(game.deck.length, 87); assert.equal(game.auditCardCounts().total, 124);
});
test('人数不足时拒绝开局', () => { const game = new GameEngine(); game.players[0].connected = true; assert.equal(game.startGame().ok, false); assert.equal(game.gameState, 'WAITING_PLAYERS'); });
for (const [number, expected] of [[0, false], [1, false], [2, true], [3, true], [4, false], [5, true], [9, false], [25, false], [29, true], [49, false], [97, true]]) test(`质数检查 ${number}`, () => assert.equal(isPrime(number), expected));
test('对手隐藏手牌与内部身份不发送', () => {
    const game = scenario(); game.players[1].ownerId = 'private-owner'; game.players[1].socketId = 'private-socket';
    const view = game.snapshot(0); assert.equal(view.playersData[0].hand.length, 1);
    for (let seat = 1; seat < 4; seat++) assert.equal(Object.hasOwn(view.playersData[seat], 'hand'), false);
    assert(!JSON.stringify(view).includes('private-owner')); assert(!JSON.stringify(view).includes('private-socket'));
});
test('人类与AI执行合法碰牌均只移动一次实体牌', () => {
    for (const automatic of [false, true]) {
        const game = scenario([['侯俊贤', '朱喆宇', '戴宇豪'], ['顾忻乐'], ['彭籽稼'], ['沈鑫浩']], '顾嘉誉');
        const move = automatic ? game.automaticAction() : { seat: 0, action: 'claim_peng', data: { cardIds: game.players[0].hand.slice(0, 2), faction: '酥酥软软' } };
        legal(game, move.seat, move.action, move.data);
        assert.deepEqual(ownNames(game, 0), ['戴宇豪']); assert.equal(game.players[0].bonds[0].cards.length, 3);
    }
});
for (const variant of ['empty', 'duplicate', 'foreign', 'wrongFaction', 'allHand', 'object', 'overflow']) test(`非法碰牌保持原状态 ${variant}`, () => {
    const game = scenario([['侯俊贤', '朱喆宇', '戴宇豪', '顾忻乐'], ['彭籽稼'], ['沈鑫浩'], ['夏运']], '顾嘉誉');
    const hand = game.players[0].hand;
    const variants = { empty: [], duplicate: [hand[0], hand[0]], foreign: [hand[0], game.players[1].hand[0]], wrongFaction: hand.slice(0, 2), allHand: [...hand], object: [{}], overflow: [...hand, hand[0]] };
    const before = stateText(game);
    assert.equal(game.act(0, 'claim_peng', { cardIds: variants[variant], faction: variant === 'wrongFaction' ? '三小只' : '酥酥软软' }).ok, false);
    assert.equal(stateText(game), before);
});
test('非法吃牌与跨席位响应保持原状态', () => {
    const game = scenario(undefined, '顾嘉誉'); const before = stateText(game);
    assert.equal(game.act(0, 'claim_chi', { cardId: game.players[0].hand[0] }).ok, false);
    assert.equal(game.act(2, 'claim_pass', {}).ok, false); assert.equal(stateText(game), before);
});
for (const value of [-1, 0.5, 100, NaN, Infinity, {}, null]) test(`非法出牌编号 ${String(value)}`, () => {
    const game = scenario(); const before = stateText(game);
    assert.equal(game.act(0, 'play_card', { cardId: value, cardIndex: value }).ok, false); assert.equal(stateText(game), before);
});
test('跨席位出牌与结算后行动被拒绝', () => {
    const game = scenario(); assert.equal(game.act(1, 'play_card', { cardId: game.players[1].hand[0] }).ok, false);
    game.finishGame(0); const before = stateText(game); assert.equal(game.act(0, 'play_card', { cardId: game.players[0].hand[0] }).ok, false); assert.equal(stateText(game), before);
});
test('合法吃牌移除关系牌并添加禁摸状态', () => {
    const game = scenario([['郑昕玮', '戴宇豪'], ['顾忻乐'], ['彭籽稼'], ['侯俊贤']], '顾嘉誉');
    legal(game, 0, 'claim_chi', { cardId: idOf(game, 0, '郑昕玮') }); assert.deepEqual(ownNames(game, 0), ['戴宇豪']); assert(game.buffs[0].noDrawNext);
});
test('合体的两张实体牌进入弃牌区', () => {
    const game = scenario([['徐翱的针织帽', '徐翱', '戴宇豪'], ['顾忻乐'], ['彭籽稼'], ['侯俊贤']]);
    legal(game, 0, 'play_card', { cardId: idOf(game, 0, '徐翱的针织帽') });
    assert.deepEqual(game.players[0].discards.map(id => game.name(id)), ['徐翱的针织帽', '徐翱']);
});
test('合体被吃后两张实体进入羁绊并触发控制', () => {
    const game = scenario([['徐翱的针织帽', '徐翱', '戴宇豪'], ['李奕潼', '温秦富'], ['彭籽稼'], ['侯俊贤']]);
    legal(game, 0, 'play_card', { cardId: idOf(game, 0, '徐翱的针织帽') });
    legal(game, 1, 'claim_chi', { cardId: idOf(game, 1, '李奕潼') });
    assert.equal(game.players[1].bonds[0].cards.length, 3); assert.equal(game.buffs[1].skipTurnCount, 1);
});
test('弃牌回收移动原实体', () => {
    const game = scenario(); const id = game.deck.pop(); game.players[2].discards.push(id);
    game.triggerOnPlaySkill(0, '王歆昊'); game.auditCardCounts(); assert(game.players[0].hand.includes(id)); assert.equal(game.players[2].discards.length, 0);
});
test('复制阵营可以读取上一项效果', () => {
    const game = scenario(); game.triggerFactionSkill(0, '增重计划'); game.triggerFactionSkill(0, '启动·王者荣耀'); assert.equal(game.buffs[1].extraDrawNext, 2); game.auditCardCounts();
});
test('复制关系可以读取上一项效果并再次复制', () => {
    const game = scenario(); game.triggerRelationSkill(0, '朱喆宇-孙佳煜', 3); game.triggerRelationSkill(0, '曾灏铭-刘嘉祺', 3); game.triggerFactionSkill(0, '启动·王者荣耀'); assert.equal(game.buffs[1].skipTurnCount, 3);
});
test('没有历史时复制不改变手牌与状态效果', () => {
    const game = scenario(); const hand = [...game.players[0].hand]; game.triggerFactionSkill(0, '启动·王者荣耀'); assert.deepEqual(game.players[0].hand, hand); assert.equal(game.lastTriggeredBond, null);
});
test('强盛集团额外出牌与实体守恒', () => {
    const game = scenario([['侯俊贤', '朱喆宇', '戴宇豪', '彭籽稼'], ['沈鑫浩', '温秦富'], ['顾忻乐'], ['夏运']], '曾灏铭', 3, ['顾忻乐']);
    legal(game, 0, 'claim_peng', { cardIds: game.players[0].hand.slice(0, 2), faction: '强盛集团' });
    assert.equal(game.remainingPlays, 2); legal(game, 0, 'play_card', { cardId: idOf(game, 0, '戴宇豪') }); assert.equal(game.turn, 0); assert.equal(game.remainingPlays, 1);
});
test('半段按组成羁绊后的手牌判断额外行动', () => {
    const game = scenario([['安以文', '侯俊贤', '戴宇豪', '彭籽稼', '顾忻乐', '夏运'], ['沈鑫浩', '唐洋'], ['温秦富'], ['范文豪']], '徐翱');
    legal(game, 0, 'claim_chi', { cardId: idOf(game, 0, '安以文') }); assert.equal(game.remainingPlays, 2);
});
test('数学王者仅在双方为质数时增加双方行动', () => {
    const game = scenario([['李奕潼', '侯俊贤', '戴宇豪', '彭籽稼'], ['顾忻乐'], ['温秦富'], ['范文豪', '唐洋']], '徐翱');
    legal(game, 0, 'claim_chi', { cardId: idOf(game, 0, '李奕潼') }); assert.equal(game.remainingPlays, 2); assert.equal(game.buffs[3].extraPlaysNext, 1);
});
test('超导战士增加3张与3次出牌并设置2回合控制', () => {
    const game = scenario(); game.triggerRelationSkill(0, '张浩泉-张浩泉', 3); assert.equal(game.players[0].hand.length, 4); assert.equal(game.remainingPlays, 4); assert.equal(game.buffs[0].skipTurnCount, 2); game.auditCardCounts();
});
test('卷王二人组直接结束回合', () => {
    const game = scenario([['杨嘉毅', '侯俊贤'], ['戴宇豪'], ['顾忻乐'], ['彭籽稼']], '张浩泉', 3, ['温秦富']);
    legal(game, 0, 'claim_peng', { cardIds: [idOf(game, 0, '杨嘉毅')], faction: '卷王二人组' }); assert.equal(game.turn, 1);
    assert.equal(game.act(0, 'play_card', { cardId: game.players[0].hand[0] }).ok, false);
});
test('卷王完成特殊胜利后保持结算', () => {
    const game = scenario([['杨嘉毅'], ['戴宇豪'], ['顾忻乐'], ['彭籽稼']], '张浩泉', 3, ['沈鑫浩']);
    legal(game, 0, 'claim_peng', { cardIds: [idOf(game, 0, '杨嘉毅')], faction: '卷王二人组' }); assert.equal(game.gameState, 'GAME_OVER');
    game.advanceTurn(); assert.equal(game.gameState, 'GAME_OVER');
});
test('护盾只抵挡一次控制', () => {
    const game = scenario(); game.buffs[1].immune = true; game.applyDebuff(1, 1); assert.equal(game.buffs[1].skipTurnCount, 0); game.applyDebuff(1, 1); assert.equal(game.buffs[1].skipTurnCount, 1);
});
test('禁止摸牌、额外摸牌与嘲讽正确消耗', () => {
    const game = scenario(); game.buffs[0].noDrawNext = true; game.startTurn(0); assert.equal(game.players[0].hand.length, 1); assert.equal(game.buffs[0].noDrawNext, false);
    game.buffs[0].extraDrawNext = 2; game.startTurn(0); assert.equal(game.players[0].hand.length, 4); assert.equal(game.buffs[0].extraDrawNext, 0);
    game.buffs[0].skipPlayNext = 1; game.startTurn(0); assert.equal(game.turn, 1); assert.equal(game.buffs[0].skipPlayNext, 0); game.auditCardCounts();
});
for (const name of ['刘鸿铭', '周晓培']) test(`${name}追加四个回合并恢复轮转`, () => {
    const game = scenario([[name, '侯俊贤', '戴宇豪'], ['顾忻乐', '夏运'], ['彭籽稼', '唐洋'], ['温秦富', '范文豪']]);
    legal(game, 0, 'play_card', { cardId: idOf(game, 0, name) });
    for (const seat of [1, 2, 3, 0]) { assert.equal(game.turn, seat); assert.equal(game.isCurrentTurnExtra, true); legal(game, seat, 'play_card', { cardId: game.players[seat].hand[0] }); }
    assert.equal(game.turn, 1); assert.equal(game.isCurrentTurnExtra, false);
});
test('追加回合中登场技能与合体失效', () => {
    const game = scenario([['徐翱的针织帽', '徐翱', '周晓培', '侯俊贤'], ['顾忻乐'], ['彭籽稼'], ['温秦富']]);
    game.isCurrentTurnExtra = true; game.remainingPlays = 2;
    legal(game, 0, 'play_card', { cardId: idOf(game, 0, '徐翱的针织帽') }); assert(idOf(game, 0, '徐翱'));
    legal(game, 0, 'play_card', { cardId: idOf(game, 0, '周晓培') }); assert.equal(game.extraTurnQueue.length, 0);
});
test('只有下家可吃碰，封印与宝牌均拒绝响应', () => {
    const game = scenario([['侯俊贤', '朱喆宇'], ['顾忻乐'], ['彭籽稼'], ['温秦富']], '顾嘉誉');
    assert(game.claimOptions(0).canPeng); assert.equal(game.claimOptions(1).canPeng, false);
    game.silenceEatPengTurns = 2; assert.equal(game.claimOptions(0).canPeng, false);
    const wild = scenario(undefined, '周晓培'); assert.equal(wild.claimOptions(0).canPeng, false); assert.equal(wild.claimOptions(0).canChi, false);
});
test('小丑截取保留牌张并检查双方胜利', () => {
    const game = scenario([['刘嘉祺', '戴宇豪'], ['徐翱', '安以文', '沈鑫浩'], ['顾忻乐'], ['彭籽稼']], '曾灏铭');
    legal(game, 0, 'claim_chi', { cardId: idOf(game, 0, '刘嘉祺') }); assert.equal(game.gameState, 'CLOWN_INTERRUPT');
    legal(game, 1, 'confirm_clown_interrupt', {}); assert.equal(game.players[1].bonds[0].cards.length, 2); assert.equal(game.turn, 1); assert.equal(game.players[0].hand.length, 2);
});
test('放弃反制执行原吃牌效果', () => {
    const game = scenario([['刘嘉祺', '戴宇豪'], ['徐翱', '安以文'], ['顾忻乐'], ['彭籽稼']], '曾灏铭');
    legal(game, 0, 'claim_chi', { cardId: idOf(game, 0, '刘嘉祺') }); legal(game, 1, 'pass_clown_interrupt', {}); assert.equal(game.players[0].bonds.length, 1); assert.equal(game.turn, 0);
});
test('透视只发给发动席位，公开状态仍然隐藏手牌', () => {
    const game = scenario(); const received = [];
    game.on('private', (seat, event, payload) => received.push({ seat, event, payload }));
    game.triggerOnPlaySkill(0, '界刘嘉祺'); assert.equal(received.length, 1); assert.equal(received[0].seat, 0); assert.equal(received[0].payload.targetSeat, 1); assert.equal(Object.hasOwn(game.snapshot(2).playersData[1], 'hand'), false);
});
test('缺少与重复实体牌触发即时检查', () => {
    const missing = scenario(); missing.deck.pop(); assert.throws(() => missing.auditCardCounts());
    const duplicate = scenario(); duplicate.deck[0] = duplicate.deck[1]; assert.throws(() => duplicate.auditCardCounts());
});
test('牌库耗尽流局，重开发牌独立', () => {
    const game = scenario(); game.players[3].discards.push(...game.deck); game.deck = []; game.startTurn(0); assert.equal(game.result.winnerSeat, null); game.auditCardCounts();
    const previous = game.gameId; game.startGame(); assert.notEqual(game.gameId, previous); assert.equal(game.result, null); assert.equal(game.deck.length, 87);
});
test('空手与沈鑫浩特殊胜利', () => {
    const empty = scenario([[], ['戴宇豪'], ['顾忻乐'], ['彭籽稼']]); assert(empty.checkWin(0)); assert.equal(empty.result.winnerSeat, 0);
    const special = scenario([['沈鑫浩'], ['戴宇豪'], ['顾忻乐'], ['彭籽稼']]); assert(special.checkWin(0)); assert.equal(special.result.winnerSeat, 0);
});
test('200场真实随机对局每一步守恒并正常结束', () => {
    for (let index = 0; index < 200; index++) {
        const game = new GameEngine(); game.players.forEach(p => { p.isAI = true; }); game.startGame();
        let count = 0;
        while (game.gameState !== 'GAME_OVER' && count++ < 1000) {
            const move = game.automaticAction(); assert(move); legal(game, move.seat, move.action, move.data);
        }
        assert.equal(game.gameState, 'GAME_OVER', `对局${index}未结束`); assert.equal(game.auditCardCounts().total, 124);
    }
});
test('额外出牌保留到具备出牌资格的回合', () => {
    const game = scenario(); game.buffs[0].extraPlaysNext = 1; game.buffs[0].skipTurnCount = 1;
    game.startTurn(0); assert.equal(game.buffs[0].extraPlaysNext, 1);
    game.buffs[0].skipPlayNext = 1; game.startTurn(0); assert.equal(game.buffs[0].extraPlaysNext, 1);
    game.startTurn(0); assert.equal(game.remainingPlays, 2); assert.equal(game.buffs[0].extraPlaysNext, 0); game.auditCardCounts();
});
test('同名牌使用不同实体编号可以参与合法碰牌', () => {
    const game = scenario([['侯俊贤', '侯俊贤', '戴宇豪'], ['顾忻乐'], ['彭籽稼'], ['温秦富']], '顾嘉誉');
    legal(game, 0, 'claim_peng', { cardIds: game.players[0].hand.slice(0, 2), faction: '酥酥软软' }); assert.equal(game.players[0].hand.length, 1);
});
test('相同组合保留全部合法阵营供玩家选择', () => {
    const names = ['徐翱', '屠明修', '刘鸿铭', '周晓培'];
    assert.deepEqual(matchedFactions(names, '曾灏铭'), ['启动·王者荣耀', '启动·英雄联盟']);
    for (const faction of matchedFactions(names, '曾灏铭')) {
        const game = scenario([[...names, '戴宇豪', '顾忻乐'], ['彭籽稼'], ['温秦富'], ['范文豪']], '曾灏铭');
        legal(game, 0, 'claim_peng', { cardIds: game.players[0].hand.slice(0, 4), faction }); assert.equal(game.players[0].bonds[0].name, faction);
    }
});
test('无效吃碰不会提前触发陷阱或消耗护盾', () => {
    const game = scenario(undefined, '范文豪'); game.buffs[0].immune = true;
    assert.equal(game.act(0, 'claim_peng', { cardIds: [], faction: '南模天团' }).ok, false); assert.equal(game.buffs[0].immune, true); assert.equal(game.buffs[0].skipTurnCount, 0);
});
test('南模天团按四个行动回合消耗', () => {
    const game = scenario(); game.triggerFactionSkill(0, '南模天团');
    for (const expected of [3, 2, 1, 0]) { game.advanceTurn(); assert.equal(game.silenceEatPengTurns, expected); }
    game.auditCardCounts();
});
