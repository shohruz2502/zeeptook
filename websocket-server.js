const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8081 });

// Импортируем базу данных
const { Pool } = require('pg');
require('dotenv').config();

// Храним последние сообщения для каждого чата
const recentMessages = new Map();

// Обработчик получения сообщений
async function handleGetMessages(ws, data) {
    try {
        const { chatId } = data;
        
        // Получаем сообщения из БД
        const result = await pool.query(`
            SELECT m.*, u.full_name as sender_name
            FROM messages m
            LEFT JOIN users u ON m.sender_id = u.id
            WHERE m.chat_id = $1
            ORDER BY m.created_at ASC
            LIMIT 100
        `, [chatId]);
        
        // Отправляем клиенту
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'messages_list',
                chatId: chatId,
                messages: result.rows
            }));
        }
    } catch (error) {
        console.error('Error getting messages:', error);
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Failed to load messages'
            }));
        }
    }
}

// Обновляем обработчик message
ws.on('message', async (message) => {
    try {
        const data = JSON.parse(message);
        
        switch (data.type) {
            case 'message':
                await handleMessage(data, userId);
                break;
            case 'get_messages':
                await handleGetMessages(ws, data);
                break;
            case 'typing':
                broadcastTyping(data, userId);
                break;
            default:
                console.log('Unknown message type:', data.type);
        }
    } catch (error) {
        console.error('WebSocket message error:', error);
    }
});


// Подключение к БД
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const connections = new Map();

wss.on('connection', (ws, request) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const userId = url.searchParams.get('userId');
    
    console.log(`🔗 WebSocket connected: user ${userId}`);
    
    connections.set(userId, ws);
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.type) {
                case 'message':
                    await handleMessage(data, userId);
                    break;
                case 'typing':
                    broadcastTyping(data, userId);
                    break;
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
        }
    });
    
    ws.on('close', () => {
        console.log(`🔗 WebSocket disconnected: user ${userId}`);
        connections.delete(userId);
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

async function handleMessage(data, senderId) {
    try {
        // Сохраняем сообщение в БД
        const result = await pool.query(`
            INSERT INTO messages (sender_id, receiver_id, content, chat_id)
            VALUES ($1, $2, $3, $4)
            RETURNING id, created_at
        `, [senderId, data.receiverId, data.content, data.chatId]);
        
        // Отправляем получателю
        const receiverWs = connections.get(data.receiverId);
        if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
            receiverWs.send(JSON.stringify({
                type: 'new_message',
                message: {
                    id: result.rows[0].id,
                    sender_id: senderId,
                    content: data.content,
                    created_at: result.rows[0].created_at
                },
                chatId: data.chatId
            }));
        }
    } catch (error) {
        console.error('Error handling message:', error);
    }
}

function broadcastTyping(data, senderId) {
    const receiverWs = connections.get(data.receiverId);
    if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
        receiverWs.send(JSON.stringify({
            type: 'typing',
            senderId: senderId,
            chatId: data.chatId,
            isTyping: data.isTyping
        }));
    }
}

console.log('🚀 WebSocket server started on port 8081');