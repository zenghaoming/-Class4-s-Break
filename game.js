'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomInt, randomUUID } = require('node:crypto');
const { CARD_DB, FACTION_INFO, RELATION_MAP, relationKey, matchedFactions } = require('./public/rules');

const emptyBuffs = () => ({ skipTurnCount: 0, immune: false, extraDrawNext: 0, noDrawNext: false, extraPlaysNext: 0, skipPlayNext: 0 });
const rejected = (code, message) => ({ ok: false, code, message });
const isPrime = n => Number.isInteger(n) && n >= 2 && Array.from({ length: Math.max(0, Math.floor(Math.sqrt(n)) - 1) }, (_, i) => i + 2).every(d => n % d !== 0);

class GameEngine extends EventEmitter {
    constructor() {
        super();
        this.players = Array.from({ length: 4 }, (_, seat) => ({ seat, name: `玩家 ${seat}`, ownerId: null, socketId: null, connected: false, isAI: false, hand: [], bonds: [], discards: [] }));
        this.registry = new Map();
        this.deck = [];
        this.buffs = this.players.map(emptyBuffs);
        this.gameState = 'WAITING_PLAYERS';
        this.gameId = null;
        this.version = 0;
        this.decisionId = randomUUID();
        this.turn = 0;
        this.pendingCardInfo = null;
        this.pendingClownInterrupt = null;
        this.silenceEatPengTurns = 0;
        this.lastTriggeredBond = null;
        this.remainingPlays = 1;
        this.unskippableNextCard = false;
        this.extraTurnQueue = [];
        this.returnTurnAfterExtra = null;
        this.isCurrentTurnExtra = false;
        this.result = null;
        this.logs = [];
    }

    name(id) { assert(this.registry.has(id), '未知卡牌编号'); return this.registry.get(id).name; }
    card(id) { return { ...this.registry.get(id) }; }
    log(type, title, action) {
        const entry = { id: randomUUID(), type, title, action };
        this.logs.push(entry);
        if (this.logs.length > 150) this.logs.shift();
        this.emit('log', entry);
    }
    fx(type, text, seat) { this.emit('fx', { type, text, seat }); }
    changed() {
        this.auditCardCounts();
        this.version++;
        this.decisionId = randomUUID();
        this.emit('change');
    }
    startGame() {
        if (!this.players.every(p => p.connected || p.isAI)) return rejected('MISSING_PLAYERS', '请等待四名玩家，或由房主补齐AI。');
        this.gameId = randomUUID();
        this.registry.clear();
        this.deck = [];
        for (const name of Object.keys(CARD_DB)) for (let copy = 0; copy < 4; copy++) {
            const id = randomUUID();
            this.registry.set(id, Object.freeze({ id, name }));
            this.deck.push(id);
        }
        for (let i = this.deck.length - 1; i > 0; i--) {
            const j = randomInt(i + 1);
            [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
        }
        this.players.forEach(p => { p.hand = []; p.bonds = []; p.discards = []; });
        this.buffs = this.players.map(emptyBuffs);
        this.pendingCardInfo = null;
        this.pendingClownInterrupt = null;
        this.silenceEatPengTurns = 0;
        this.lastTriggeredBond = null;
        this.extraTurnQueue = [];
        this.returnTurnAfterExtra = null;
        this.unskippableNextCard = false;
        this.result = null;
        this.logs = [];
        this.gameState = 'PLAYING';
        this.emit('match_started', { gameId: this.gameId });
        for (let seat = 0; seat < 4; seat++) this.draw(seat, 9);
        this.log('system', '对局启动', '全员起手9张。清空手牌，或仅剩1张沈鑫浩即可获胜。');
        this.startTurn(0);
        this.changed();
        return { ok: true };
    }
    returnToLobby() {
        this.registry.clear(); this.deck = []; this.gameId = null;
        this.players.forEach(p => { p.hand = []; p.bonds = []; p.discards = []; });
        this.buffs = this.players.map(emptyBuffs);
        this.pendingCardInfo = null; this.pendingClownInterrupt = null;
        this.extraTurnQueue = []; this.returnTurnAfterExtra = null;
        this.lastTriggeredBond = null; this.silenceEatPengTurns = 0;
        this.remainingPlays = 1; this.isCurrentTurnExtra = false;
        this.unskippableNextCard = false; this.result = null;
        this.gameState = 'WAITING_PLAYERS';
        this.changed();
    }
    draw(seat, count) {
        const before = this.players[seat].hand.length;
        while (count-- > 0 && this.deck.length) this.players[seat].hand.push(this.deck.pop());
        return this.players[seat].hand.length - before;
    }
    takeRandom(hand) { return hand.length ? hand.splice(randomInt(hand.length), 1)[0] : null; }
    finishGame(seat = null) {
        this.gameState = 'GAME_OVER';
        this.extraTurnQueue = []; this.returnTurnAfterExtra = null;
        this.pendingClownInterrupt = null;
        this.result = seat === null
            ? { winnerSeat: null, reason: '牌库耗尽，本局流局。' }
            : { winnerSeat: seat, winnerName: this.players[seat].name, reason: this.players[seat].hand.length === 0 ? `P${seat} 清空手牌，获得胜利！` : `P${seat} 手牌仅剩沈鑫浩，获得胜利！` };
        this.log('system', '对局结束', this.result.reason);
    }
    checkWin(firstSeat = this.turn) {
        for (let offset = 0; offset < 4; offset++) {
            const seat = (firstSeat + offset) % 4;
            const hand = this.players[seat].hand;
            if (hand.length === 0 || (hand.length === 1 && this.name(hand[0]) === '沈鑫浩')) {
                this.finishGame(seat);
                return true;
            }
        }
        return false;
    }
    startTurn(seat, extra = false) {
        if (this.gameState === 'GAME_OVER') return;
        this.turn = seat;
        this.gameState = 'PLAYING';
        this.isCurrentTurnExtra = extra;
        this.remainingPlays = 1;
        this.unskippableNextCard = false;
        if (this.checkWin(seat)) return;
        if (!this.deck.length) { this.finishGame(); return; }
        const buffs = this.buffs[seat];
        if (buffs.skipTurnCount > 0) {
            buffs.skipTurnCount--;
            this.log('system', `P${seat} 暂停行动`, '控制效果消耗1个回合。');
            this.advanceTurn();
            return;
        }
        const count = buffs.noDrawNext ? 0 : 1 + buffs.extraDrawNext;
        buffs.noDrawNext = false; buffs.extraDrawNext = 0;
        this.draw(seat, count);
        if (this.checkWin(seat)) return;
        if (buffs.skipPlayNext > 0) {
            buffs.skipPlayNext--;
            this.log('system', `P${seat} 被嘲讽`, '本回合结束出牌，后续仍可响应吃碰。');
            this.advanceTurn();
            return;
        }
        this.remainingPlays += buffs.extraPlaysNext;
        buffs.extraPlaysNext = 0;
    }
    advanceTurn() {
        if (this.gameState === 'GAME_OVER') return;
        if (this.silenceEatPengTurns > 0) this.silenceEatPengTurns--;
        if (this.extraTurnQueue.length) this.startTurn(this.extraTurnQueue.shift(), true);
        else if (this.returnTurnAfterExtra !== null) {
            const next = this.returnTurnAfterExtra;
            this.returnTurnAfterExtra = null;
            this.startTurn(next);
        } else this.startTurn((this.turn + 1) % 4);
    }
    claimOptions(seat) {
        const none = { canChi: false, canPeng: false, chiOptions: [], pengOptions: [] };
        const pending = this.pendingCardInfo;
        if (!pending || this.gameState !== 'WAITING_ACTION' || seat !== (pending.fromPlayer + 1) % 4 || this.silenceEatPengTurns > 0 || pending.unclaimable || CARD_DB[pending.card].isWildcard) return none;
        const hand = this.players[seat].hand;
        const chiOptions = hand.filter(id => CARD_DB[pending.card].relations.includes(this.name(id))).map(id => ({ cardId: id, name: this.name(id), relation: relationKey(pending.card, this.name(id)) }));
        const pengOptions = CARD_DB[pending.card].factions.filter(f => hand.filter(id => CARD_DB[this.name(id)].isWildcard || CARD_DB[this.name(id)].factions.includes(f)).length >= FACTION_INFO[f].req - 1).map(f => ({ faction: f, reqCardsCount: FACTION_INFO[f].req - 1 }));
        return { canChi: chiOptions.length > 0, canPeng: pengOptions.length > 0, chiOptions, pengOptions };
    }
    validate(seat, action, data) {
        if (!Number.isInteger(seat) || seat < 0 || seat > 3 || !data || typeof data !== 'object' || Array.isArray(data)) return rejected('INVALID_INPUT', '操作参数不完整。');
        if (action === 'play_card') {
            if (this.gameState !== 'PLAYING' || this.turn !== seat) return rejected('WRONG_TURN', '当前尚未轮到你出牌。');
            if (typeof data.cardId !== 'string' || !this.players[seat].hand.includes(data.cardId)) return rejected('INVALID_CARD', '请选择自己手中的一张牌。');
            return { ok: true };
        }
        if (action === 'confirm_clown_interrupt' || action === 'pass_clown_interrupt') {
            return this.gameState === 'CLOWN_INTERRUPT' && this.pendingClownInterrupt?.interceptorSeat === seat ? { ok: true } : rejected('WRONG_PHASE', '当前没有可响应的反制。');
        }
        if (!['claim_pass', 'claim_chi', 'claim_peng'].includes(action)) return rejected('UNKNOWN_ACTION', '无法识别此操作。');
        if (this.gameState !== 'WAITING_ACTION' || seat !== (this.pendingCardInfo.fromPlayer + 1) % 4) return rejected('WRONG_PHASE', '当前吃碰响应不属于你。');
        if (action === 'claim_pass') return { ok: true };
        const options = this.claimOptions(seat);
        if (action === 'claim_chi') return options.chiOptions.some(option => option.cardId === data.cardId) ? { ok: true } : rejected('INVALID_CHI', '所选手牌无法组成该关系。');
        if (!Array.isArray(data.cardIds) || data.cardIds.length < 1 || data.cardIds.length > 4 || new Set(data.cardIds).size !== data.cardIds.length || !data.cardIds.every(id => typeof id === 'string' && this.players[seat].hand.includes(id))) return rejected('INVALID_PENG', '碰牌必须使用自己持有且没有重复编号的手牌。');
        const matches = matchedFactions(data.cardIds.map(id => this.name(id)), this.pendingCardInfo.card);
        return matches.includes(data.faction) ? { ok: true } : rejected('INVALID_PENG', '所选张数或阵营不符合规则。');
    }
    act(seat, action, data = {}) {
        const validation = this.validate(seat, action, data);
        if (!validation.ok) return validation;
        if (action === 'play_card') this.playCard(seat, data.cardId);
        else if (action === 'claim_pass') this.finishDiscardFlow();
        else if (action === 'claim_peng') this.executePeng(seat, data.cardIds, data.faction);
        else if (action === 'claim_chi') this.preCheckClownInterrupt(seat, data.cardId);
        else if (action === 'confirm_clown_interrupt') this.executeClownInterrupt();
        else {
            const pending = this.pendingClownInterrupt;
            this.pendingClownInterrupt = null;
            this.executeChi(pending.claimerSeat, pending.cardId);
        }
        this.changed();
        return { ok: true };
    }
    playCard(seat, id) {
        const hand = this.players[seat].hand;
        const name = this.name(id);
        hand.splice(hand.indexOf(id), 1);
        const cards = [id];
        if (!this.isCurrentTurnExtra && name === '徐翱的针织帽') {
            const index = hand.findIndex(cardId => this.name(cardId) === '徐翱');
            if (index >= 0) cards.push(hand.splice(index, 1)[0]);
        }
        this.pendingCardInfo = { cards, card: cards.length === 2 ? '徐翱' : name, rawCard: name, fromPlayer: seat, isHatCombo: cards.length === 2, unclaimable: this.isCurrentTurnExtra || this.unskippableNextCard };
        this.unskippableNextCard = false;
        this.remainingPlays--;
        this.log('onplay', `P${seat} 出牌`, `打出【${name}】${cards.length === 2 ? '，与徐翱合体' : ''}。`);
        if (!this.isCurrentTurnExtra) this.triggerOnPlaySkill(seat, name);
        if (this.checkWin(seat)) return;
        if (this.remainingPlays > 0) { this.discardPending(); return; }
        if (this.pendingCardInfo.unclaimable || CARD_DB[name].isWildcard || this.silenceEatPengTurns > 0) { this.finishDiscardFlow(); return; }
        this.gameState = 'WAITING_ACTION';
        const options = this.claimOptions((seat + 1) % 4);
        if (!options.canChi && !options.canPeng) this.finishDiscardFlow();
    }
    discardPending() {
        if (this.pendingCardInfo) this.players[this.pendingCardInfo.fromPlayer].discards.push(...this.pendingCardInfo.cards);
        this.pendingCardInfo = null;
    }
    finishDiscardFlow() { this.discardPending(); this.advanceTurn(); }
    applyDebuff(seat, turns, type = 'skipTurnCount') {
        if (this.buffs[seat].immune) {
            this.buffs[seat].immune = false;
            this.log('system', `P${seat} 护盾生效`, '抵挡1次控制效果。');
        } else this.buffs[seat][type] += turns;
    }
    triggerOnPlaySkill(seat, name) {
        const next = (seat + 1) % 4;
        if (name === '刘鸿铭' || name === '周晓培') {
            this.extraTurnQueue.push(next, (seat + 2) % 4, (seat + 3) % 4, seat);
            this.returnTurnAfterExtra = next;
            this.log('onplay', CARD_DB[name].onPlayDesc.split('】')[0] + '】', '从下家起全员追加1个回合。');
        } else if (name === '王歆昊') {
            const candidates = this.players.flatMap(p => p.discards.filter(id => !CARD_DB[this.name(id)].isWildcard).map(id => ({ seat: p.seat, id })));
            if (candidates.length) {
                const chosen = candidates[randomInt(candidates.length)];
                const source = this.players[chosen.seat].discards;
                source.splice(source.indexOf(chosen.id), 1);
                this.players[seat].hand.push(chosen.id);
                this.log('onplay', '圣诞礼物', `P${seat} 从弃牌区取回【${this.name(chosen.id)}】。`);
            }
        } else if (name === '界刘嘉祺') this.emit('private', seat, 'reveal_hands', { targetSeat: next, targetName: this.players[next].name, cards: this.players[next].hand.map(id => this.name(id)) });
        else if (name === '界曾灏铭') { this.buffs[seat].skipTurnCount++; this.applyDebuff(next, 1); }
        else if (name === '界彭籽稼') this.buffs[seat].immune = true;
        else if (name === '王齐岳') {
            const taken = this.takeRandom(this.players[next].hand);
            if (taken) this.players[seat].hand.push(taken);
        } else if (name === '夏运') this.applyDebuff(next, 1, 'skipPlayNext');
    }
    handleEatTrap(seat, pending) {
        if (pending.isHatCombo) this.applyDebuff(seat, 1);
        if (['温秦富', '范文豪'].includes(pending.rawCard)) this.applyDebuff(seat, 1);
        if (pending.rawCard === '唐洋') this.draw(seat, 1);
    }
    enterClaimTurn(seat) {
        this.turn = seat; this.gameState = 'PLAYING';
        this.isCurrentTurnExtra = false;
        this.remainingPlays = 1 + this.buffs[seat].extraPlaysNext;
        this.buffs[seat].extraPlaysNext = 0;
        this.unskippableNextCard = false;
    }
    finishClaim(seat) {
        if (this.checkWin(seat)) return;
        if (this.remainingPlays === 0) this.advanceTurn();
    }
    executePeng(seat, cardIds, faction) {
        const pending = this.pendingCardInfo;
        const hand = this.players[seat].hand;
        for (const id of cardIds) hand.splice(hand.indexOf(id), 1);
        this.players[seat].bonds.push({ type: 'faction', name: faction, cards: [...pending.cards, ...cardIds] });
        this.pendingCardInfo = null;
        this.enterClaimTurn(seat);
        this.handleEatTrap(seat, pending);
        this.triggerFactionSkill(seat, faction);
        this.log('faction', `P${seat} 碰牌`, `组成【${faction}】，移出${cardIds.length}张手牌；当前剩余${hand.length}张。`);
        this.finishClaim(seat);
    }
    preCheckClownInterrupt(claimerSeat, cardId) {
        const names = [this.pendingCardInfo.card, this.name(cardId)];
        let required = null;
        if (names.includes('曾灏铭') && names.includes('刘嘉祺')) required = ['徐翱', '安以文'];
        if (names.includes('徐翱') && names.includes('安以文')) required = ['曾灏铭', '刘嘉祺'];
        const interceptor = required ? this.players.find(p => p.seat !== claimerSeat && required.every(name => p.hand.some(id => this.name(id) === name))) : null;
        if (interceptor) {
            this.pendingClownInterrupt = { interceptorSeat: interceptor.seat, claimerSeat, cardId, interceptCards: names };
            this.gameState = 'CLOWN_INTERRUPT';
        } else this.executeChi(claimerSeat, cardId);
    }
    executeClownInterrupt() {
        const { interceptorSeat, claimerSeat, cardId } = this.pendingClownInterrupt;
        const pending = this.pendingCardInfo;
        const claimant = this.players[claimerSeat];
        claimant.hand.splice(claimant.hand.indexOf(cardId), 1);
        const interceptor = this.players[interceptorSeat];
        interceptor.bonds.push({ type: 'relation', name: '小丑二人组·截取组合', cards: [...pending.cards, cardId] });
        if (interceptor.hand.length) claimant.hand.push(interceptor.hand.pop());
        this.pendingCardInfo = null; this.pendingClownInterrupt = null;
        this.enterClaimTurn(interceptorSeat);
        this.handleEatTrap(interceptorSeat, pending);
        this.log('relation', '小丑二人组', `P${interceptorSeat} 截取P${claimerSeat}的组合，并赠予1张手牌。`);
        this.finishClaim(interceptorSeat);
    }
    executeChi(seat, cardId) {
        const pending = this.pendingCardInfo;
        const key = relationKey(this.name(cardId), pending.card);
        const hand = this.players[seat].hand;
        hand.splice(hand.indexOf(cardId), 1);
        this.players[seat].bonds.push({ type: 'relation', name: key, cards: [...pending.cards, cardId] });
        this.pendingCardInfo = null;
        this.enterClaimTurn(seat);
        this.handleEatTrap(seat, pending);
        this.triggerRelationSkill(seat, key, pending.fromPlayer);
        this.log('relation', `P${seat} 吃牌`, `组成【${key}】，当前剩余${hand.length}张手牌。`);
        this.finishClaim(seat);
    }
    copyLastEffect(seat) {
        const effect = this.lastTriggeredBond;
        if (!effect) { this.log('system', '复制羁绊', '当前没有可复制的羁绊。'); return; }
        this.log('system', '复制羁绊', `P${seat} 发动【${effect.name}】。`);
        if (effect.type === 'faction') this.triggerFactionSkill(seat, effect.name);
        else this.triggerRelationSkill(seat, effect.name, (seat + 3) % 4);
    }
    triggerFactionSkill(seat, faction) {
        assert(Object.hasOwn(FACTION_INFO, faction), '未知阵营');
        const next = (seat + 1) % 4;
        if (faction === '启动·王者荣耀') { this.copyLastEffect(seat); return; }
        if (faction === '启动·英雄联盟') {
            const choices = ['强盛集团', '三小只', '酥酥软软', '增重计划', '卷王二人组'];
            this.triggerFactionSkill(seat, choices[randomInt(choices.length)]);
            return;
        }
        if (faction === '强盛集团') { this.draw(seat, 1); this.remainingPlays++; this.unskippableNextCard = true; }
        else if (faction === '三小只') {
            const cards = this.players.map(p => this.takeRandom(p.hand));
            cards.forEach((id, index) => { if (id) this.players[(index + 1) % 4].hand.push(id); });
        } else if (faction === '酥酥软软') this.fx('splash', '🌸 酥酥软软 🌸', seat);
        else if (faction === '增重计划') this.buffs[next].extraDrawNext++;
        else if (faction === '梦之队·一队' || faction === '梦之队·二队') {
            const own = this.players[seat].hand;
            const other = this.players[next].hand;
            if (own.length && (faction === '梦之队·一队' ? own.length > other.length : own.length < other.length)) other.push(own.pop());
        } else if (faction === '卷王二人组') { this.draw(seat, 1); this.remainingPlays = 0; }
        else if (faction === '南模天团') this.silenceEatPengTurns = 4;
        this.lastTriggeredBond = { type: 'faction', name: faction };
    }
    triggerRelationSkill(seat, key, fromPlayer) {
        assert(Object.hasOwn(RELATION_MAP, key), '未知关系');
        const next = (seat + 1) % 4;
        if (key === '曾灏铭-刘嘉祺') { this.copyLastEffect(seat); return; }
        if (key === '徐翱-安以文' && this.players[seat].hand.length >= 5) this.remainingPlays++;
        else if (key === '徐翱-李奕潼' && isPrime(this.players[seat].hand.length) && isPrime(this.players[fromPlayer].hand.length)) { this.remainingPlays++; this.buffs[fromPlayer].extraPlaysNext++; }
        else if (key === '朱喆宇-孙佳煜') this.applyDebuff(next, 1);
        else if (key === '刘子豪-安以文') this.players.forEach(p => this.draw(p.seat, 1));
        else if (key === '顾嘉誉-郑昕玮' || key === '杨嘉毅-郑昕玮') this.buffs[seat].noDrawNext = true;
        else if (key === '单冯烨-刘嘉祺' && this.players[seat].hand.length && this.players[next].hand.length) {
            const own = this.takeRandom(this.players[seat].hand);
            const other = this.takeRandom(this.players[next].hand);
            this.players[seat].hand.push(other); this.players[next].hand.push(own);
        } else if (key === '张浩泉-张浩泉') { this.draw(seat, 3); this.remainingPlays += 3; this.applyDebuff(seat, 2); }
        else if (key === '曾灏铭-曾灏铭' || key === '界曾灏铭-界曾灏铭') this.draw(seat, 1);
        this.lastTriggeredBond = { type: 'relation', name: key };
    }
    actingSeat() {
        if (this.gameState === 'PLAYING') return this.turn;
        if (this.gameState === 'WAITING_ACTION') return (this.pendingCardInfo.fromPlayer + 1) % 4;
        if (this.gameState === 'CLOWN_INTERRUPT') return this.pendingClownInterrupt.interceptorSeat;
        return null;
    }
    cardValue(seat, id) {
        const name = this.name(id), card = CARD_DB[name];
        const hand = this.players[seat].hand.map(c => this.name(c));
        return (name === '沈鑫浩' ? 50 : 0) + (card.isWildcard ? 12 : 0) + card.relations.filter(other => hand.includes(other)).length * 4 + card.factions.reduce((sum, f) => sum + hand.filter(other => CARD_DB[other].factions.includes(f)).length / FACTION_INFO[f].req, 0) - (name === '徐翱的针织帽' && hand.includes('徐翱') ? 15 : 0);
    }
    automaticAction(timeout = false) {
        const seat = this.actingSeat();
        if (seat === null) return null;
        if (this.gameState === 'CLOWN_INTERRUPT') return { seat, action: timeout ? 'pass_clown_interrupt' : 'confirm_clown_interrupt', data: {} };
        if (this.gameState === 'PLAYING') {
            const cards = [...this.players[seat].hand].sort((a, b) => this.cardValue(seat, a) - this.cardValue(seat, b));
            return { seat, action: 'play_card', data: { cardId: cards[0] } };
        }
        if (timeout) return { seat, action: 'claim_pass', data: {} };
        const options = this.claimOptions(seat);
        if (options.canPeng) {
            const best = [...options.pengOptions].sort((a, b) => b.reqCardsCount - a.reqCardsCount)[0];
            const cards = this.players[seat].hand.filter(id => CARD_DB[this.name(id)].isWildcard || CARD_DB[this.name(id)].factions.includes(best.faction)).sort((a, b) => this.cardValue(seat, a) - this.cardValue(seat, b)).slice(0, best.reqCardsCount);
            return { seat, action: 'claim_peng', data: { cardIds: cards, faction: best.faction } };
        }
        if (options.canChi) return { seat, action: 'claim_chi', data: { cardId: options.chiOptions[0].cardId } };
        return { seat, action: 'claim_pass', data: {} };
    }
    auditCardCounts() {
        if (!this.gameId) return { total: 0 };
        const all = [...this.deck, ...this.players.flatMap(p => [...p.hand, ...p.discards, ...p.bonds.flatMap(b => b.cards)]), ...(this.pendingCardInfo?.cards || [])];
        assert.equal(all.length, 124, '卡牌总数必须为124');
        assert.equal(new Set(all).size, 124, '实体卡牌编号重复');
        const counts = Object.fromEntries(Object.keys(CARD_DB).map(name => [name, 0]));
        for (const id of all) counts[this.name(id)]++;
        for (const count of Object.values(counts)) assert.equal(count, 4, '每种牌必须保留4张');
        return { total: all.length, counts };
    }
    snapshot(seat) {
        assert(Number.isInteger(seat) && seat >= 0 && seat < 4, '接收席位无效');
        return {
            gameId: this.gameId, version: this.version, decisionId: this.decisionId, gameState: this.gameState, turn: this.turn,
            deckCount: this.deck.length, pendingCard: this.pendingCardInfo?.card || null,
            pendingCards: this.pendingCardInfo ? this.pendingCardInfo.cards.map(id => this.card(id)) : [],
            silenceEatPengTurns: this.silenceEatPengTurns, remainingPlays: this.remainingPlays, isCurrentTurnExtra: this.isCurrentTurnExtra,
            clownInterruptInfo: this.pendingClownInterrupt ? { interceptorSeat: this.pendingClownInterrupt.interceptorSeat, claimerSeat: this.pendingClownInterrupt.claimerSeat, interceptCards: [...this.pendingClownInterrupt.interceptCards] } : null,
            actionOptions: { [seat]: this.claimOptions(seat) }, result: this.result ? { ...this.result } : null,
            playersData: this.players.map((p, index) => ({
                seat: index, name: p.name, connected: p.connected, isAI: p.isAI, reserved: Boolean(p.ownerId),
                handCount: p.hand.length, ...(index === seat ? { hand: p.hand.map(id => this.card(id)) } : {}),
                bonds: p.bonds.map(b => ({ ...b, cards: b.cards.map(id => this.card(id)) })),
                discards: p.discards.map(id => this.card(id)), buffs: { ...this.buffs[index] }
            }))
        };
    }
}

module.exports = { GameEngine, isPrime, emptyBuffs };
