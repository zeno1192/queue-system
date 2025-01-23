const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// SQLiteデータベースのセットアップ
const db = new sqlite3.Database('./data.db', (err) => {
    if (err) {
        console.error('データベース接続エラー:', err.message);
    } else {
        console.log('データベースに接続しました。');
    }
});

// テーブル作成（存在しない場合に作成）
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        number INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS current_numbers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        number INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        number INTEGER,
        has_reserved INTEGER
    )`);
});

// 呼び出し中番号と待機中番号を初期化
let currentNumbers = [];
let queue = [];

// サーバー起動時にデータベースから復元
db.serialize(() => {
    db.all(`SELECT number FROM current_numbers`, [], (err, rows) => {
        if (err) throw err;
        currentNumbers = rows.map(row => row.number);
    });

    db.all(`SELECT number FROM queue`, [], (err, rows) => {
        if (err) throw err;
        queue = rows.map(row => row.number);
    });
});

// 静的ファイルを提供
app.use(express.static('public'));

// WebSocket接続処理
wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        const data = JSON.parse(message);

        // ユーザーが接続時に状態をリクエスト
        if (data.action === 'connect') {
            const userId = data.userId;

            db.get(`SELECT * FROM users WHERE id = ?`, [userId], (err, user) => {
                if (err) throw err;

                if (!user) {
                    // ユーザーが存在しない場合、新規作成
                    db.run(`INSERT INTO users (id, has_reserved) VALUES (?, ?)`, [userId, 0]);
                    ws.send(JSON.stringify({
                        type: 'status',
                        hasReserved: false,
                        currentNumbers: currentNumbers,
                        waiting: queue.length,
                        message: 'まだ予約されていません。',
                    }));
                } else {
                    // ユーザーが既存の場合、状態を復元
                    const waitingCount = calculateWaitingCount(user.number);
                    ws.send(JSON.stringify({
                        type: 'status',
                        hasReserved: user.has_reserved === 1,
                        number: user.number,
                        currentNumbers: currentNumbers,
                        waiting: waitingCount,
                        message: user.has_reserved === 1
                            ? `あなたの番号は ${user.number} です。あと ${waitingCount} 人待ちです。`
                            : 'まだ予約されていません。',
                    }));
                }
            });
        }

        // 予約処理
        if (data.action === 'reserve') {
            const userId = data.userId;

            db.get(`SELECT has_reserved FROM users WHERE id = ?`, [userId], (err, user) => {
                if (err) throw err;

                if (user.has_reserved === 1) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'すでに予約済みです。受け取り完了後に再度予約してください。',
                    }));
                    return;
                }

                const number = queue.length > 0 ? queue.shift() : currentNumbers.length + queue.length + 1;

                db.run(`UPDATE users SET number = ?, has_reserved = 1 WHERE id = ?`, [number, userId]);
                ws.send(JSON.stringify({
                    type: 'reserved',
                    number: number,
                }));

                if (currentNumbers.length < 10) {
                    currentNumbers.push(number);
                } else {
                    queue.push(number);
                }

                updateDatabase();
                broadcast({
                    type: 'updateQueue',
                    currentNumbers: currentNumbers,
                    waiting: queue.length,
                });
            });
        }

        // 受け取り完了処理
        if (data.action === 'complete') {
            const userId = data.userId;

            db.get(`SELECT number FROM users WHERE id = ?`, [userId], (err, user) => {
                if (err) throw err;

                const number = user.number;

                currentNumbers = currentNumbers.filter(n => n !== number);
                db.run(`UPDATE users SET number = NULL, has_reserved = 0 WHERE id = ?`, [userId]);

                if (queue.length > 0) {
                    currentNumbers.push(queue.shift());
                }

                updateDatabase();
                broadcast({
                    type: 'updateQueue',
                    currentNumbers: currentNumbers,
                    waiting: queue.length,
                });
            });
        }
    });
});

// 待機人数を計算
function calculateWaitingCount(userNumber) {
    const queueNumbers = [...currentNumbers, ...queue];
    const userIndex = queueNumbers.indexOf(userNumber);
    return userIndex >= 0 ? userIndex : queueNumbers.length;
}

// データベース更新処理
function updateDatabase() {
    db.run(`DELETE FROM current_numbers`);
    currentNumbers.forEach(number => {
        db.run(`INSERT INTO current_numbers (number) VALUES (?)`, [number]);
    });

    db.run(`DELETE FROM queue`);
    queue.forEach(number => {
        db.run(`INSERT INTO queue (number) VALUES (?)`, [number]);
    });
}

// 全クライアントにメッセージを送信
function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

// サーバーを起動
server.listen(3000, () => {
    console.log('サーバーがポート3000で起動しました');
});
