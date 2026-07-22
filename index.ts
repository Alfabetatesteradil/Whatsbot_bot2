import makeWASocket, { useMultiFileAuthState, DisconnectReason, WAMessage } from '@whiskeysockets/baileys';
import * as admin from 'firebase-admin';

// Твой номер телефона для привязки (без плюса)
const phoneNumber = "77057114243";

// ==========================================
// ИНИЦИАЛИЗАЦИЯ FIREBASE
// ==========================================
let serviceAccount: any;

if (process.env.FIREBASE_KEY) {
    try {
        serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
    } catch (e) {
        console.error('❌ Ошибка парсинга FIREBASE_KEY');
    }
} else {
    try {
        serviceAccount = require('./firebase-key.json');
    } catch (e) {
        console.error('❌ Переменная FIREBASE_KEY не найдена!');
    }
}

if (serviceAccount && !admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();
const usersCollection = db.collection('profiles');

const RANKS = [
    { name: 'Дерево', maxXp: 50 },
    { name: 'Уголь', maxXp: 100 },
    { name: 'Железо', maxXp: 150 },
    { name: 'Золото', maxXp: 200 },
    { name: 'Алмаз', maxXp: 500 }
];

async function getProfile(userJid: string) {
    const docId = userJid.replace(/[^a-zA-Z0-9]/g, '_'); 
    const docRef = usersCollection.doc(docId);
    const docSnap = await docRef.get();

    if (docSnap.exists) {
        return docSnap.data() as { rankIndex: number; xp: number; rebirths: number };
    } else {
        const newProfile = { rankIndex: 0, xp: 0, rebirths: 0 };
        await docRef.set(newProfile);
        return newProfile;
    }
}

async function addXp(userJid: string, amount: number): Promise<string> {
    const docId = userJid.replace(/[^a-zA-Z0-9]/g, '_');
    const docRef = usersCollection.doc(docId);
    const profile = await getProfile(userJid);

    profile.xp += amount;
    let message = ` (+${amount} XP)`;

    let currentRank = RANKS[profile.rankIndex];

    if (profile.xp >= currentRank.maxXp) {
        if (profile.rankIndex < RANKS.length - 1) {
            profile.xp -= currentRank.maxXp;
            profile.rankIndex += 1;
            const newRank = RANKS[profile.rankIndex];
            message += `\n🎉 *ПОВЫШЕНИЕ!* Новый ранг: *${newRank.name}*!`;
        } else {
            profile.xp = currentRank.maxXp;
            message += `\n💎 *Максимальный ранг (Алмаз)!* Доступно *!перерождение*!`;
        }
    }

    await docRef.set({
        rankIndex: profile.rankIndex,
        xp: profile.xp,
        rebirths: profile.rebirths
    }, { merge: true });

    return message;
}

// ==========================================
// ХРАНИЛИЩА АКТИВНЫХ ИГР
// ==========================================
const duels: { [jid: string]: { player1: string, player2?: string, p1Hp: number, p2Hp: number, p1Aim: number, p2Aim: number, p1Shield: boolean, p2Shield: boolean, turn: string } } = {};
const xoGames: { [jid: string]: { board: string[]; turn: '❌' | '⭕' } } = {};
const rpsGames: { [jid: string]: { player1: string, p1Choice?: string } } = {};
const quizGames: { [jid: string]: { word: string, hint: string, shuffled: string } } = {};

function renderBoard(board: string[]) {
    return `${board[0]} | ${board[1]} | ${board[2]}\n---+---+---\n${board[3]} | ${board[4]} | ${board[5]}\n---+---+---\n${board[6]} | ${board[7]} | ${board[8]}`;
}

function checkWinXO(board: string[], player: string) {
    const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    return wins.some(comb => comb.every(i => board[i] === player));
}

const quizDatabase = [
    { word: 'майнкрафт', hint: 'Популярная песочница с кубами' },
    { word: 'термукс', hint: 'Эмулятор терминала для Android' },
    { word: 'клавиатура', hint: 'Устройство для ввода текста' },
    { word: 'разработчик', hint: 'Человек, который пишет код' },
    { word: 'смартфон', hint: 'Карманное умное устройство' },
    { word: 'алмаз', hint: 'Самый ценный минерал и высший ранг' }
];

// ==========================================
// ОБРАБОТЧИК СООБЩЕНИЙ
// ==========================================
async function handleMessages(sock: any, msg: WAMessage) {
    const textRaw = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
    if (!textRaw) return;

    const text = textRaw.trim();
    const textLower = text.toLowerCase();
    const chatId = msg.key.remoteJid!;
    const sender = msg.key.participant || msg.key.remoteJid!;
    const pushName = msg.pushName || 'Игрок';

    console.log(`📩 Получено сообщение: "${text}" от ${pushName}`);

    if (textLower === '!пинг') {
        const start = Date.now();
        await usersCollection.doc('ping_test').get();
        const latency = Date.now() - start;
        await sock.sendMessage(chatId, { text: `🏓 *Понг!*\n⚡ Задержка отклика базы: *${latency} мс*` });
        return;
    }

    if (textLower === '!меню') {
        const menuText = 
`🎮 *ГЛАВНОЕ МЕНЮ ИГРОВОГО БОТА* 🎮

⚙️ *Системное и Профиль:*
• *!ранг* (или *!ранг я*) — Ранг, XP и перерождения
• *!перерождение* (или *!ребирт*) — Сброс Алмаза (+1 перерождение)
• *!пинг* — Проверка скорости базы
• *!какиграть [название]* — Инструкция к игре

🎯 *Список игр:*
1. ❌⭕ *Крестики-Нолики* (+10 XP) ➔ *!хо* | *!ход [1-9]*
2. 🤠 *Дуэль* (+20 XP) ➔ *!дуэль* | *!принять*
3. 🎰 *Рулетка* (+50 XP) ➔ *!рулетка* (или *!риск*)
4. ✊ *КМБ* (+30 XP) ➔ *!рпк камень/ножницы/бумага*
5. 🧠 *Викторина* (+5 XP) ➔ *!викторина* | *!ответ [слово]*`;

        await sock.sendMessage(chatId, { text: menuText });
        return;
    }

    if (textLower.startsWith('!какиграть')) {
        const args = text.split(' ');
        const gameName = args[1]?.toLowerCase();
        let helpText = '❓ Напишите название игры, например: *!какиграть хо*';

        if (gameName === 'дуэль' || gameName === 'дуель') helpText = `🤠 *«ДУЭЛЬ»* (+20 XP)\n1. *!дуэль*, второй: *!принять*.\n2. Команды: *!выстрел*, *!прицел*, *!щит*.`;
        else if (gameName === 'хо' || gameName === 'крестики') helpText = `❌⭕ *«КРЕСТИКИ-НОЛИКИ»* (+10 XP)\n1. *!хо*\n2. Ходы: *!ход 1..9*`;
        else if (gameName === 'рулетка') helpText = `🎰 *«РУЛЕТКА»* (+50 XP)\nНапишите *!рулетка*. Выпадет 1-100. При >= 70 победа!`;
        else if (gameName === 'кмб' || gameName === 'рпк') helpText = `✊ *«КМБ»* (+30 XP)\nНапишите *!рпк камень* (или ножницы/бумага).`;
        else if (gameName === 'викторина') helpText = `🧠 *«ВИКТОРИНА»* (+5 XP)\n*!викторина*, затем *!ответ [слово]*`;

        await sock.sendMessage(chatId, { text: helpText });
        return;
    }

    if (textLower === '!ранг я' || textLower.startsWith('!ранг')) {
        const profile = await getProfile(sender);
        const currentRank = RANKS[profile.rankIndex];
        await sock.sendMessage(chatId, { text: `${pushName}, ${currentRank.name} ${profile.xp}/${currentRank.maxXp} | перерождение ${profile.rebirths}` });
        return;
    }

    if (textLower === '!перерождение' || textLower === '!ребирт') {
        const profile = await getProfile(sender);
        const maxRankIndex = RANKS.length - 1;
        if (profile.rankIndex === maxRankIndex && profile.xp >= RANKS[maxRankIndex].maxXp) {
            profile.rankIndex = 0; profile.xp = 0; profile.rebirths += 1;
            const docId = sender.replace(/[^a-zA-Z0-9]/g, '_');
            await usersCollection.doc(docId).set(profile);
            await sock.sendMessage(chatId, { text: `✨ *ПЕРЕРОЖДЕНИЕ!* ${pushName}, рангов: Дерево, перерождений: *${profile.rebirths}*! 🚀` });
        } else {
            await sock.sendMessage(chatId, { text: `❌ Перерождение доступно только на максимальном ранге (Алмаз)!` });
        }
        return;
    }

    // ИГРА: ДУЭЛЬ
    if (textLower === '!дуэль') {
        if (duels[chatId]) { await sock.sendMessage(chatId, { text: '⚠️ В этом чате уже идет дуэль!' }); return; }
        duels[chatId] = { player1: sender, p1Hp: 100, p2Hp: 100, p1Aim: 20, p2Aim: 20, p1Shield: false, p2Shield: false, turn: sender };
        await sock.sendMessage(chatId, { text: `🤠 *Дуэль объявлена!*\nНапишите *!принять*!` });
        return;
    }

    if (textLower === '!принять') {
        const duel = duels[chatId];
        if (!duel) { await sock.sendMessage(chatId, { text: '❌ Вызов никто не бросал.' }); return; }
        if (duel.player2) return;
        if (duel.player1 === sender) { await sock.sendMessage(chatId, { text: '⚠️ Нельзя играть с самим собой!' }); return; }
        duel.player2 = sender;
        await sock.sendMessage(chatId, { text: `⚔️ *Дуэль началась!*\nХодит Игрок 1: *!выстрел*, *!прицел*, *!щит*` });
        return;
    }

    if (textLower === '!выстрел' || textLower === '!прицел' || textLower === '!щит') {
        const duel = duels[chatId];
        if (!duel || !duel.player2 || duel.turn !== sender) return;
        const isP1 = sender === duel.player1;
        const attackerName = isP1 ? 'Игрок 1' : 'Игрок 2';
        let logMessage = '';

        if (textLower === '!прицел') {
            if (isP1) duel.p1Aim += 20; else duel.p2Aim += 20;
            logMessage = `🔭 *${attackerName}* прицелился!`;
        } else if (textLower === '!щит') {
            if (isP1) duel.p1Shield = true; else duel.p2Shield = true;
            logMessage = `🛡️ *${attackerName}* поднял щит!`;
        } else if (textLower === '!выстрел') {
            let baseChance = isP1 ? duel.p1Aim : duel.p2Aim;
            if (isP1 ? duel.p2Shield : duel.p1Shield) { baseChance -= 20; if (isP1) duel.p2Shield = false; else duel.p1Shield = false; }
            if (baseChance < 0) baseChance = 0;
            if (Math.floor(Math.random() * 100) + 1 <= baseChance) {
                if (isP1) duel.p2Hp -= 40; else duel.p1Hp -= 40;
                logMessage = `💥 *${attackerName}* попал (-40 HP)!`;
            } else { logMessage = `💨 *${attackerName}* промахнулся!`; }
            if (isP1) duel.p1Aim = 20; else duel.p2Aim = 20;
        }

        if (duel.p1Hp <= 0 || duel.p2Hp <= 0) {
            const isP1Winner = duel.p1Hp > 0;
            const xpNotice = await addXp(isP1Winner ? duel.player1 : duel.player2, 20);
            await sock.sendMessage(chatId, { text: `${logMessage}\n\n🏆 *Победил ${isP1Winner ? 'Игрок 1' : 'Игрок 2'}!*${xpNotice}` });
            delete duels[chatId];
            return;
        }
        duel.turn = isP1 ? duel.player2 : duel.player1;
        await sock.sendMessage(chatId, { text: `${logMessage}\n❤️ И1: ${duel.p1Hp} | ❤️ И2: ${duel.p2Hp}\n👉 Ход: *${isP1 ? 'Игрок 2' : 'Игрок 1'}*` });
        return;
    }

    // ИГРА: ХО
    if (textLower === '!хо') {
        xoGames[chatId] = { board: ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'], turn: '❌' };
        await sock.sendMessage(chatId, { text: `🎮 *Крестики-Нолики!*\n\n${renderBoard(xoGames[chatId].board)}\n\nХод: *!ход 1..9*` });
        return;
    }

    if (textLower.startsWith('!ход ')) {
        const game = xoGames[chatId];
        if (!game) return;
        const cellIndex = parseInt(text.split(' ')[1]) - 1;
        if (isNaN(cellIndex) || cellIndex < 0 || cellIndex > 8 || game.board[cellIndex] === '❌' || game.board[cellIndex] === '⭕') return;

        game.board[cellIndex] = game.turn;

        if (checkWinXO(game.board, game.turn)) {
            const xpNotice = await addXp(sender, 10);
            await sock.sendMessage(chatId, { text: `🎉 Победили ${game.turn}! ${pushName} получает *+10 XP*!${xpNotice}\n\n${renderBoard(game.board)}` });
            delete xoGames[chatId];
            return;
        }

        if (game.board.every(cell => cell === '❌' || cell === '⭕')) {
            await sock.sendMessage(chatId, { text: `🤝 Ничья!\n\n${renderBoard(game.board)}` });
            delete xoGames[chatId];
            return;
        }

        game.turn = game.turn === '❌' ? '⭕' : '❌';
        await sock.sendMessage(chatId, { text: `Ход: ${game.turn}\n\n${renderBoard(game.board)}` });
        return;
    }

    // ИГРА: РУЛЕТКА
    if (textLower === '!рулетка' || textLower === '!риск') {
        const roll = Math.floor(Math.random() * 100) + 1;
        if (roll >= 70) {
            const xpNotice = await addXp(sender, 50);
            await sock.sendMessage(chatId, { text: `🎰 *УСПЕХ!* Выпало ${roll}!\n${pushName} забирает +50 XP!${xpNotice}` });
        } else {
            await sock.sendMessage(chatId, { text: `💥 *НЕУДАЧА!* Выпало ${roll}. (0 XP)` });
        }
        return;
    }

    // ИГРА: КМБ
    if (textLower.startsWith('!рпк ')) {
        const choice = text.split(' ')[1]?.toLowerCase();
        if (!['камень', 'ножницы', 'бумага'].includes(choice)) return;

        if (!rpsGames[chatId]) {
            rpsGames[chatId] = { player1: sender, p1Choice: choice };
            await sock.sendMessage(chatId, { text: `✊ *${pushName}* сделал выбор в КМБ! Ждем второго (!рпк ...)` });
        } else {
            const p1 = rpsGames[chatId].player1;
            const p2 = sender;
            const c1 = rpsGames[chatId].p1Choice!;
            const c2 = choice;
            let resultText = `🎮 *Результаты КМБ:*\nИгрок 1: ${c1} | Игрок 2: ${c2}\n\n`;

            if (c1 === c2) resultText += `🤝 Ничья!`;
            else if ((c1 === 'камень' && c2 === 'ножницы') || (c1 === 'ножницы' && c2 === 'бумага') || (c1 === 'бумага' && c2 === 'камень')) {
                const xpNotice = await addXp(p1, 30);
                resultText += `🎉 Победил Игрок 1!${xpNotice}`;
            } else {
                const xpNotice = await addXp(p2, 30);
                resultText += `🎉 Победил Игрок 2!${xpNotice}`;
            }
            await sock.sendMessage(chatId, { text: resultText });
            delete rpsGames[chatId];
        }
        return;
    }

    // ИГРА: ВИКТОРИНА
    if (textLower === '!викторина') {
        if (quizGames[chatId]) return;
        const item = quizDatabase[Math.floor(Math.random() * quizDatabase.length)];
        const shuffledWord = item.word.split('').sort(() => Math.random() - 0.5).join('').toUpperCase();
        quizGames[chatId] = { word: item.word.toLowerCase(), hint: item.hint, shuffled: shuffledWord };
        await sock.sendMessage(chatId, { text: `🧠 *ВИКТОРИНА!*\nБуквы: *${shuffledWord}* (+5 XP)\nОтвет: *!ответ [слово]*` });
        return;
    }

    if (textLower === '!подсказка') {
        const game = quizGames[chatId];
        if (game) await sock.sendMessage(chatId, { text: `💡 Подсказка: ${game.hint}` });
        return;
    }

    if (textLower.startsWith('!ответ ')) {
        const game = quizGames[chatId];
        if (!game) return;
        if (text.slice(7).trim().toLowerCase() === game.word) {
            const xpNotice = await addXp(sender, 5);
            await sock.sendMessage(chatId, { text: `🎉 *Правильно!* ${pushName} угадал слово *${game.word.toUpperCase()}*!${xpNotice}` });
            delete quizGames[chatId];
        } else {
            await sock.sendMessage(chatId, { text: `❌ Неверно!` });
        }
    }
}

// ==========================================
// СТАРТ БОТА (ПО КОДУ ПРИВЯЗКИ)
// ==========================================
let isConnecting = false;

async function startBot() {
    if (isConnecting) return;
    isConnecting = true;

    // Новая чистая папка сессии v6
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info_v6');

    const sock = makeWASocket({
        auth: state,
        browser: ['Mac OS', 'Chrome', '125.0.0.0'],
        syncFullHistory: false,
    });

    // Запрос кода привязки, если устройство еще не авторизовано
    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                console.log('\n==============================================');
                console.log(`🔑 КОД ДЛЯ ВХОДА В WHATSAPP: ${code}`);
                console.log('==============================================\n');
            } catch (err) {
                console.error('❌ Ошибка генерации кода привязки:', err);
            }
        }, 4000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            isConnecting = false;
            const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`Соединение закрыто (Код: ${statusCode}). Переподключение...`);
            if (shouldReconnect) {
                setTimeout(() => startBot(), 3000);
            }
        } else if (connection === 'open') {
            isConnecting = false;
            console.log('==============================================');
            console.log('✅ БОТ УСПЕШНО ПОДКЛЮЧЕН И ГОТОВ К РАБОТЕ!');
            console.log('==============================================');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type === 'notify') {
            for (const msg of m.messages) {
                const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

                if (msg.key.fromMe) {
                    if (text.startsWith('!')) {
                        await handleMessages(sock, msg);
                    }
                } else {
                    await handleMessages(sock, msg);
                }
            }
        }
    });
}

startBot();
