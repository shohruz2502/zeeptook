require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const WebSocket = require('ws');

const app = express();

const wss = new WebSocket.Server({ noServer: true });
// Configuration from .env
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-key-for-development';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const APP_GOOGLE_CLIENT_ID = process.env.APP_GOOGLE_CLIENT_ID; // Для вебвью приложения

// Поддержка как DATABASE_URL (для Vercel + Neon), так и отдельных переменных
let poolConfig;

if (process.env.DATABASE_URL) {
  poolConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: 10
  };
} else {
  poolConfig = {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT || 5432,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: 10
  };
}

// PostgreSQL connection
const pool = new Pool(poolConfig);

// Хранилище WebSocket соединений
const connections = new Map();
const dealConnections = new Map();

// WebSocket сервер
wss.on('connection', (ws, request) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const userId = url.searchParams.get('userId');
    const dealId = url.searchParams.get('dealId');
    
    if (dealId) {
        // Соединение для чата сделки
        if (!dealConnections.has(dealId)) {
            dealConnections.set(dealId, new Map());
        }
        dealConnections.get(dealId).set(userId, ws);
        
        ws.on('close', () => {
            if (dealConnections.has(dealId)) {
                dealConnections.get(dealId).delete(userId);
            }
        });
    } else {
        // Обычное соединение для чатов
        connections.set(userId, ws);
        
        ws.on('close', () => {
            connections.delete(userId);
        });
    }
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleWebSocketMessage(data, userId, dealId);
        } catch (error) {
            console.error('WebSocket message error:', error);
        }
    });
});

// Обработка WebSocket сообщений
function handleWebSocketMessage(data, userId, dealId) {
    switch (data.type) {
        case 'message':
            // Обработка обычных сообщений
            handleChatMessage(data, userId, dealId);
            break;
        case 'status_change':
            broadcastStatusChange(data, dealId);
            break;
        default:
            console.log('Unknown message type:', data.type);
    }
}

// Новая функция для обработки сообщений чата
async function handleChatMessage(data, senderId, dealId) {
    try {
        const { chatId, message } = data;
        
        console.log(`📨 WebSocket message from ${senderId} to chat ${chatId}`);
        
        // Определяем тип чата и получателя
        let receiverId = null;
        let chatType = 'regular';
        
        if (chatId === 'support' || chatId.startsWith('support_')) {
            // ДЛЯ ПОДДЕРЖКИ - используем НОВУЮ ТАБЛИЦУ
            chatType = 'support';
            
            // Проверяем, есть ли уже chatId, если нет - создаем
            let actualChatId = chatId;
            if (chatId === 'support') {
                actualChatId = `support_${senderId}_${Date.now()}`;
            }
            
            // Сохраняем в support_messages
            const result = await pool.query(`
                INSERT INTO support_messages (user_id, content, chat_id, is_from_admin)
                VALUES ($1, $2, $3, false)
                RETURNING id, created_at
            `, [senderId, message.content, actualChatId]);
            
            // Формируем данные для трансляции
            const broadcastData = {
                chatId: actualChatId,
                message: {
                    id: result.rows[0].id,
                    sender_id: senderId,
                    content: message.content,
                    created_at: result.rows[0].created_at,
                    chat_type: 'support'
                }
            };
            
            // Отправляем через WebSocket
            broadcastMessage(broadcastData, senderId, dealId);
            
            console.log(`✅ Support message saved to support_messages for chat ${actualChatId}`);
            return;
            
        } else {
            // Для обычного чата - получаем информацию о чате
            const chatResult = await pool.query(`
                SELECT user1_id, user2_id FROM chats WHERE id = $1
            `, [chatId]);
            
            if (chatResult.rows.length === 0) {
                console.error(`❌ Chat ${chatId} not found`);
                return;
            }
            
            const chat = chatResult.rows[0];
            
            // Проверяем, что отправитель является участником чата
            if (chat.user1_id !== parseInt(senderId) && chat.user2_id !== parseInt(senderId)) {
                console.error(`❌ User ${senderId} is not a member of chat ${chatId}`);
                return;
            }
            
            // Определяем получателя
            receiverId = chat.user1_id === parseInt(senderId) ? chat.user2_id : chat.user1_id;
            
            // Сохраняем сообщение в БД (старая таблица messages)
            const result = await pool.query(`
                INSERT INTO messages (sender_id, receiver_id, content, chat_id, chat_type)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING id, created_at
            `, [senderId, receiverId, message.content, chatId, chatType]);
            
            // Формируем данные для трансляции
            const broadcastData = {
                chatId: chatId,
                message: {
                    id: result.rows[0].id,
                    sender_id: senderId,
                    content: message.content,
                    created_at: result.rows[0].created_at,
                    receiver_id: receiverId
                }
            };
            
            // Отправляем через WebSocket
            broadcastMessage(broadcastData, senderId, dealId);
            
            console.log(`✅ Message saved to DB and broadcasted for chat ${chatId}`);
        }
        
    } catch (error) {
        console.error('❌ Error handling chat message:', error);
    }
}

// Рассылка сообщений - ОСТАВЬ ЭТУ ФУНКЦИЮ
function broadcastMessage(data, senderId, dealId) {
    const message = {
        type: 'message',
        chatId: data.chatId,
        message: data.message
    };
    
    if (dealId) {
        // Для чата сделки
        const dealWs = dealConnections.get(dealId);
        if (dealWs) {
            dealWs.forEach((ws, userId) => {
                if (userId !== senderId && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(message));
                }
            });
        }
    } else {
        // Для обычного чата
        connections.forEach((ws, userId) => {
            if (userId !== senderId && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(message));
            }
        });
    }
}

// Middleware
app.use(cors({
  origin: ['http://localhost:3000', 'https://zeeptook.vercel.app'],
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Test database connection
async function testDatabaseConnection() {
    try {
        const client = await pool.connect();
        console.log('✅ Database connected successfully');
        client.release();
        return true;
    } catch (error) {
        console.error('❌ Database connection failed:', error.message);
        return false;
    }
}

// Функция для генерации уникального ID чата поддержки
function generateSupportChatId(userId) {
    return `support_${userId}_${Date.now()}`;
}

// Функция для отправки сообщения в Telegram через бота
async function sendToTelegram(message, userInfo = null, chatType = 'support') {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.error('❌ Telegram bot token or chat ID not configured');
        return false;
    }
    
    try {
        let text = '';
        
        // Форматируем сообщение в зависимости от типа чата
        if (chatType === 'support') {
            text = `🆘 НОВОЕ СООБЩЕНИЕ В ЧАТ ПОДДЕРЖКИ\n`;
            text += `👤 ID пользователя: ${userInfo?.userId || 'Неизвестно'}\n`;
            text += `📧 Email: ${userInfo?.email || 'Не указан'}\n`;
            text += `👤 Имя: ${userInfo?.name || 'Не указано'}\n`;
            text += `🆔 Chat ID: ${userInfo?.chatId || 'Не указан'}\n`;
            text += `📝 Сообщение: ${message}`;
        } else {
            // Для обычных уведомлений
            text = message;
            if (userInfo) {
                text = `👤 ${userInfo.name}\n📧 ${userInfo.email}\n💬 ${message}`;
            }
        }
        
        const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: text,
                parse_mode: 'HTML'
            })
        });
        
        const responseData = await response.json();
        
        if (!response.ok) {
            console.error('❌ Telegram API error:', responseData);
            return false;
        }
        
        console.log('✅ Message sent to Telegram successfully');
        return true;
    } catch (error) {
        console.error('❌ Telegram send error:', error);
        return false;
    }
}

// Функция для сохранения/получения ID чата поддержки в LocalStorage (симуляция на сервере)
function getSupportChatIdFromStorage(userId) {
    // В реальности это должно быть на клиенте
    // Здесь мы имитируем хранение в базе данных
    return `support_${userId}`;
}

// Utility function to format time ago
function formatTimeAgo(date) {
    const now = new Date();
    const diffMs = now - new Date(date);
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'только что';
    if (diffMins < 60) return `${diffMins} мин назад`;
    if (diffHours < 24) return `${diffHours} ч назад`;
    if (diffDays < 7) return `${diffDays} дн назад`;
    return new Date(date).toLocaleDateString('ru-RU');
}

// Authentication middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid token' });
        }
        req.user = user;
        next();
    });
};

// Функция для генерации кода сделки
function generateDealCode() {
    const date = new Date();
    const dateStr = date.toISOString().slice(2, 10).replace(/-/g, '');
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    return `DEAL-${dateStr}-${random}`;
}

// Routes

// Serve main pages
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/favorites', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'favorites.html'));
});

app.get('/ad-details', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'ad-details.html'));
});

app.get('/add-ad', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'add-ad.html'));
});

app.get('/messages', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'messages.html'));
});

app.get('/profile', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Operator pages
app.get('/operator-login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'operator-login.html'));
});

app.get('/operator-dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'operator-dashboard.html'));
});

app.get('/operator-deals', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'operator-deals.html'));
});

app.get('/operator-chat', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'operator-chat.html'));
});

app.get('/deal-page', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'deal-page.html'));
});

app.get('/operator-profile', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'operator-profile.html'));
});

// Google Config endpoint
app.get('/api/config/google', (req, res) => {
    const clientType = req.query.clientType || 'web';
    
    let googleClientId;
    if (clientType === 'app') {
        googleClientId = APP_GOOGLE_CLIENT_ID || 'not-configured';
        console.log(`📱 Providing APP Google Client ID for ${clientType}`);
    } else {
        googleClientId = GOOGLE_CLIENT_ID || 'not-configured';
        console.log(`🌐 Providing WEB Google Client ID for ${clientType}`);
    }
    
    res.json({
        success: true,
        googleClientId: googleClientId,
        redirectUri: `${req.protocol}://${req.get('host')}`,
        clientType: clientType
    });
});

// Обмен authorization code на access token
async function exchangeCodeForToken(code, clientType = 'web') {
    try {
        console.log(`🔄 Exchanging code for token for ${clientType}...`);
        
        const clientId = clientType === 'app' ? APP_GOOGLE_CLIENT_ID : GOOGLE_CLIENT_ID;
        const clientSecret = clientType === 'app' ? null : GOOGLE_CLIENT_SECRET;
        
        if (!clientId) {
            throw new Error(`Google Client ID not configured for ${clientType}`);
        }
        
        // ВАЖНО: Определяем правильный redirect_uri
        let redirectUri;
        
        if (clientType === 'app') {
            // Для приложения используем ту же страницу
            redirectUri = window.location.origin + window.location.pathname;
        } else {
            // Для веба определяем в зависимости от окружения
            redirectUri = process.env.NODE_ENV === 'production' 
                ? 'https://zeeptook.vercel.app/register.html' 
                : 'http://localhost:3000/register.html';
        }
        
        console.log(`📱 Using redirect_uri: ${redirectUri}`);
        
        const tokenParams = {
            code: code,
            client_id: clientId,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code'
        };
        
        // Добавляем секрет только для веб-приложения
        if (clientType === 'web' && clientSecret) {
            tokenParams.client_secret = clientSecret;
        }
        
        const response = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams(tokenParams)
        });

        if (!response.ok) {
            const errorData = await response.json();
            console.error('❌ Token exchange error:', errorData);
            throw new Error('Failed to exchange code for token: ' + (errorData.error || 'unknown'));
        }

        const tokenData = await response.json();
        console.log('✅ Token exchange successful');
        return tokenData;
    } catch (error) {
        console.error('❌ Code exchange error:', error);
        throw error;
    }
}

// Получение данных пользователя из Google API
async function getGoogleUserInfo(accessToken) {
    try {
        const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        });
        
        if (!response.ok) {
            throw new Error('Failed to fetch user info from Google');
        }
        
        return await response.json();
    } catch (error) {
        console.error('❌ Google API error:', error);
        return null;
    }
}

// Google OAuth endpoint - авторизация по code
app.post('/api/auth/google', async (req, res) => {
    try {
        const { code, clientType = 'web' } = req.body;
        
        console.log(`🔐 Google auth attempt with code for ${clientType}`);
        
        // Проверяем конфигурацию в зависимости от типа клиента
        if (clientType === 'web') {
            if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
                return res.status(503).json({ error: 'Google OAuth is not configured for web' });
            }
        } else if (clientType === 'app') {
            if (!APP_GOOGLE_CLIENT_ID) {
                return res.status(503).json({ error: 'Google OAuth is not configured for app' });
            }
        } else {
            return res.status(400).json({ error: 'Invalid client type' });
        }
        
        if (!code) {
            return res.status(400).json({ error: 'Authorization code is required' });
        }

        // Exchange code for tokens с учетом типа клиента
        const tokenData = await exchangeCodeForToken(code, clientType);
        const { access_token } = tokenData;

        // Get user info from Google
        const userInfo = await getGoogleUserInfo(access_token);
        if (!userInfo) {
            return res.status(400).json({ error: 'Failed to get user info from Google' });
        }

        console.log(`🔐 ${clientType.toUpperCase()} Google user info:`, { 
            email: userInfo.email, 
            name: userInfo.name,
            sub: userInfo.sub 
        });

        // Проверяем существование пользователя
        const userResult = await pool.query(
            'SELECT * FROM users WHERE google_id = $1 OR email = $2',
            [userInfo.sub, userInfo.email]
        );

        if (userResult.rows.length > 0) {
            // User exists - login
            const user = userResult.rows[0];
            
            // Update Google ID if missing
            if (!user.google_id) {
                await pool.query(
                    'UPDATE users SET google_id = $1 WHERE id = $2',
                    [userInfo.sub, user.id]
                );
            }
            
            // Generate JWT token
            const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET);
            
            console.log(`✅ ${clientType.toUpperCase()} Google user logged in:`, user.email);

            return res.json({
                success: true,
                exists: true,
                token,
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    full_name: user.full_name,
                    avatar_url: user.avatar_url,
                    rating: user.rating
                }
            });
        } else {
            // New user - return user data for additional info
            console.log(`🆕 New ${clientType} Google user:`, userInfo.email);
            return res.json({
                success: true,
                exists: false,
                user: {
                    google_id: userInfo.sub,
                    email: userInfo.email,
                    full_name: userInfo.name,
                    avatar_url: userInfo.picture,
                    email_verified: userInfo.email_verified
                }
            });
        }

    } catch (error) {
        console.error('❌ Google auth error:', error);
        res.status(500).json({ error: 'Google authentication failed: ' + error.message });
    }
});

// Backup endpoint for direct access token
app.post('/api/auth/google/token', async (req, res) => {
    try {
        const { access_token } = req.body;
        
        if (!access_token) {
            return res.status(400).json({ error: 'Access token is required' });
        }

        // Get user info from Google
        const userInfo = await getGoogleUserInfo(access_token);
        if (!userInfo) {
            return res.status(400).json({ error: 'Failed to get user info from Google' });
        }

        console.log('🔐 Google direct token auth:', userInfo.email);

        // Check if user already exists
        const userResult = await pool.query(
            'SELECT * FROM users WHERE google_id = $1 OR email = $2',
            [userInfo.sub, userInfo.email]
        );

        if (userResult.rows.length > 0) {
            const user = userResult.rows[0];
            
            if (!user.google_id) {
                await pool.query(
                    'UPDATE users SET google_id = $1 WHERE id = $2',
                    [userInfo.sub, user.id]
                );
            }
            
            const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET);
            
            console.log('✅ Google user logged in (direct):', user.email);

            return res.json({
                success: true,
                exists: true,
                token,
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    full_name: user.full_name,
                    avatar_url: user.avatar_url,
                    rating: user.rating
                }
            });
        } else {
            return res.json({
                success: true,
                exists: false,
                user: {
                    google_id: userInfo.sub,
                    email: userInfo.email,
                    full_name: userInfo.name,
                    avatar_url: userInfo.picture,
                    email_verified: userInfo.email_verified
                }
            });
        }

    } catch (error) {
        console.error('❌ Google token auth error:', error);
        res.status(500).json({ error: 'Google authentication failed' });
    }
});

// Завершение регистрации через Google
app.post('/api/auth/google/complete', async (req, res) => {
    try {
        console.log('🔐 Google complete registration REQUEST BODY:', JSON.stringify(req.body, null, 2));
        
        const { 
            google_id, 
            email, 
            full_name, 
            username, 
            password,  
            birth_year,
            avatar_url,
            auth_method = 'google' 
        } = req.body;

        console.log('🔐 Parsed data:', { 
            google_id, email, full_name, username, 
            password_len: password ? password.length : 0, 
            birth_year, 
            auth_method 
        });

        // Валидация
        if (!google_id || !email || !full_name || !username || !password || !birth_year) {
            console.error('❌ Missing fields:', { google_id, email, full_name, username, password: !!password, birth_year });
            return res.status(400).json({ error: 'Все обязательные поля должны быть заполнены' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Пароль должен быть не менее 6 символов' });
        }

        const currentYear = new Date().getFullYear();
        if (birth_year < 1900 || birth_year > currentYear) {
            return res.status(400).json({ error: 'Укажите корректный год рождения (1900-' + currentYear + ')' });
        }

        // Проверка существования пользователя
        const userExists = await pool.query(
            'SELECT id FROM users WHERE google_id = $1 OR email = $2 OR username = $3',
            [google_id, email, username]
        );

        if (userExists.rows.length > 0) {
            return res.status(400).json({ error: 'Пользователь уже существует' });
        }

        // Хеширование пароля
        const hashedPassword = await bcrypt.hash(password, 10);

        // Создание пользователя
        console.log('🔐 Creating user with birth_year:', birth_year);
        const result = await pool.query(
            `INSERT INTO users (
                username, email, password, full_name, 
                avatar_url, google_id, auth_method, birth_year
            ) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id, username, email, full_name, avatar_url, rating, created_at, birth_year`,
            [username, email, hashedPassword, full_name, 
             avatar_url || null, google_id, auth_method, birth_year]
        );

        const user = result.rows[0];
        
        // Генерация токена
        const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET);

        console.log('✅ Google user registered successfully:', user.email);

        res.json({
            success: true,
            message: 'Регистрация завершена успешно',
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                full_name: user.full_name,
                avatar_url: user.avatar_url,
                rating: user.rating,
                birth_year: user.birth_year,
                created_at: user.created_at
            }
        });

    } catch (error) {
        console.error('❌ Google complete registration error DETAILS:', error);
        console.error('❌ Error stack:', error.stack);
        res.status(500).json({ error: 'Internal server error: ' + error.message });
    }
});


// Auth routes
app.post('/api/register', async (req, res) => {
    try {
        const { 
            username, email, password, full_name, 
            birth_year,  // ← ДОБАВЛЕНО
            avatar_url, google_id, auth_method = 'email',
        } = req.body;

        console.log('🔐 Registration attempt:', { username, email, auth_method });

        // For Google auth, username is optional
        if (auth_method === 'email' && (!username || !password)) {
            return res.status(400).json({ error: 'Username and password are required for email registration' });
        }

        if (!email || !full_name) {
            return res.status(400).json({ error: 'Email and full name are required' });
        }

        // Валидация года рождения для email регистрации
        if (auth_method === 'email' && !birth_year) {
            return res.status(400).json({ error: 'Year of birth is required for email registration' });
        }

        if (birth_year) {
            const currentYear = new Date().getFullYear();
            if (birth_year < 1900 || birth_year > currentYear) {
                return res.status(400).json({ error: 'Укажите корректный год рождения' });
            }
        }

        // Check if user exists
        let userExists;
        if (google_id) {
            userExists = await pool.query(
                'SELECT id FROM users WHERE google_id = $1 OR email = $2 OR username = $3',
                [google_id, email, username]
            );
        } else {
            userExists = await pool.query(
                'SELECT id FROM users WHERE username = $1 OR email = $2',
                [username, email]
            );
        }

        if (userExists.rows.length > 0) {
            return res.status(400).json({ error: 'User already exists' });
        }

        // For Google auth, generate random username if not provided
        let actualUsername = username;
        if (auth_method === 'google' && !username) {
            actualUsername = 'user_' + Math.random().toString(36).substr(2, 9);
        }

        // Hash password for email registration
        let hashedPassword = null;
        if (auth_method === 'email') {
            hashedPassword = await bcrypt.hash(password, 10);
        }

        // Create user
        const result = await pool.query(
            `INSERT INTO users (
                username, email, password, full_name, 
                avatar_url, google_id, auth_method, birth_year  // ← ДОБАВЛЕНО В SQL
            ) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)  // ← ДОБАВЛЕН $8
             RETURNING id, username, email, full_name, avatar_url, rating, created_at, birth_year`,
            [actualUsername, email, hashedPassword, full_name, 
             avatar_url, google_id, auth_method, birth_year]  // ← ДОБАВЛЕНО В ПАРАМЕТРЫ
        );

        const user = result.rows[0];
        const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET);

        console.log('✅ User registered successfully:', user.email);

        res.json({
            message: 'User registered successfully',
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                full_name: user.full_name,
                avatar_url: user.avatar_url,
                rating: user.rating,
                birth_year: user.birth_year,  // ← ДОБАВЛЕНО
                created_at: user.created_at
            }
        });

    } catch (error) {
        console.error('❌ Registration error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        // Validation
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }

        // Find user
        const result = await pool.query(
            'SELECT * FROM users WHERE username = $1 OR email = $1',
            [username]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        const user = result.rows[0];

        // Check if user has password (Google users might not have password)
        if (!user.password) {
            return res.status(400).json({ error: 'Please use Google sign-in for this account' });
        }

        // Check password
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        // Generate token
        const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET);

        console.log('✅ User logged in:', user.email);

        res.json({
            message: 'Login successful',
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                full_name: user.full_name,
                avatar_url: user.avatar_url,
                rating: user.rating,
                birth_year: user.birth_year
            }
        });
    } catch (error) {
        console.error('❌ Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Ads routes - UPDATED WITH BASE64 PHOTO SUPPORT
app.get('/api/ads', async (req, res) => {
    try {
        const { page = 1, limit = 20, category, search } = req.query;
        const offset = (page - 1) * limit;

        console.log('🔍 GET /api/ads called with:', { page, limit, category, search });

        let query = `
            SELECT 
                a.*,
                u.username as seller_username,
                u.full_name as seller_name,
                u.rating as seller_rating,
                c.name as category_name,
                c.icon as category_icon,
                COUNT(*) OVER() as total_count,
                (SELECT image_data FROM ad_photos WHERE ad_id = a.id ORDER BY display_order LIMIT 1) as main_image
            FROM ads a
            LEFT JOIN users u ON a.user_id = u.id
            LEFT JOIN categories c ON a.category_id = c.id
            WHERE a.is_active = TRUE
        `;
        let params = [];
        let paramCount = 0;

        if (category && category !== 'all') {
            paramCount++;
            query += ` AND c.name = $${paramCount}`;
            params.push(category);
        }

        if (search) {
            paramCount++;
            query += ` AND (a.title ILIKE $${paramCount} OR a.description ILIKE $${paramCount})`;
            params.push(`%${search}%`);
        }

        query += ` ORDER BY a.created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
        params.push(parseInt(limit), offset);

        console.log('🔍 Query:', query, 'Params:', params);

        const result = await pool.query(query, params);

        // Check favorites for authenticated users
        const authHeader = req.headers['authorization'];
        let favoriteAds = [];
        if (authHeader) {
            const token = authHeader.split(' ')[1];
            try {
                const decoded = jwt.verify(token, JWT_SECRET);
                const favoritesResult = await pool.query(
                    'SELECT ad_id FROM favorites WHERE user_id = $1',
                    [decoded.userId]
                );
                favoriteAds = favoritesResult.rows.map(row => row.ad_id);
            } catch (error) {
                // Token is invalid, continue without favorites
            }
        }

        console.log(`📊 Loaded ${result.rows.length} ads`);

        res.json({
            ads: result.rows.map(ad => ({
                id: ad.id,
                title: ad.title,
                description: ad.description,
                price: ad.price,
                category: ad.category_name,
                location: ad.location,
                isUrgent: ad.is_urgent,
                isFavorite: favoriteAds.includes(ad.id),
                seller: {
                    username: ad.seller_username,
                    name: ad.seller_name,
                    rating: ad.seller_rating
                },
                image: ad.main_image || null,
                time: formatTimeAgo(ad.created_at),
                views: ad.views
            })),
            total: result.rows[0]?.total_count || 0,
            page: parseInt(page),
            totalPages: Math.ceil((result.rows[0]?.total_count || 0) / limit)
        });
    } catch (error) {
        console.error('❌ Get ads error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/ads/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // Increment views
        await pool.query(
            'UPDATE ads SET views = views + 1 WHERE id = $1',
            [id]
        );

        const adResult = await pool.query(`
            SELECT 
                a.*,
                u.username as seller_username,
                u.full_name as seller_name,
                u.rating as seller_rating,
                u.created_at as seller_since,
                u.avatar_url as seller_avatar,
                c.name as category_name
            FROM ads a
            LEFT JOIN users u ON a.user_id = u.id
            LEFT JOIN categories c ON a.category_id = c.id
            WHERE a.id = $1 AND a.is_active = TRUE
        `, [id]);

        if (adResult.rows.length === 0) {
            return res.status(404).json({ error: 'Ad not found' });
        }

        const ad = adResult.rows[0];

        // Get photos for this ad
        const photosResult = await pool.query(`
            SELECT id, image_data, display_order 
            FROM ad_photos 
            WHERE ad_id = $1 
            ORDER BY display_order
        `, [id]);

        // Check if favorite
        let isFavorite = false;
        const authHeader = req.headers['authorization'];
        if (authHeader) {
            const token = authHeader.split(' ')[1];
            try {
                const decoded = jwt.verify(token, JWT_SECRET);
                const favoriteResult = await pool.query(
                    'SELECT 1 FROM favorites WHERE user_id = $1 AND ad_id = $2',
                    [decoded.userId, id]
                );
                isFavorite = favoriteResult.rows.length > 0;
            } catch (error) {
                // Token is invalid
            }
        }

        console.log(`📄 Ad viewed: ${ad.title}`);

        res.json({
            id: ad.id,
            title: ad.title,
            description: ad.description,
            price: ad.price,
            category: ad.category_name,
            location: ad.location,
            isUrgent: ad.is_urgent,
            isFavorite: isFavorite,
            views: ad.views,
            imageUrls: photosResult.rows.map(photo => photo.image_data),
            seller: {
                id: ad.user_id,
                username: ad.seller_username,
                name: ad.seller_name,
                rating: ad.seller_rating,
                avatar_url: ad.seller_avatar,
                since: formatTimeAgo(ad.seller_since)
            },
            time: formatTimeAgo(ad.created_at)
        });
    } catch (error) {
        console.error('❌ Get ad error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// UPDATED: Create ad with Base64 photo support
app.post('/api/ads', async (req, res) => {
    try {
        const { title, description, price, category_id, location, is_urgent, seller_info, photos = [] } = req.body;
        
        // Validation
        if (!title || !description || !category_id) {
            return res.status(400).json({ error: 'Title, description and category are required' });
        }

        // Validate photos limit
        if (photos.length > 3) {
            return res.status(400).json({ error: 'Maximum 3 photos allowed per ad' });
        }

        // Determine user_id - either from token or null for anonymous
        let user_id = null;
        let actual_seller_info = seller_info || {};

        const authHeader = req.headers['authorization'];
        if (authHeader) {
            const token = authHeader.split(' ')[1];
            try {
                const decoded = jwt.verify(token, JWT_SECRET);
                user_id = decoded.userId;
            } catch (error) {
                // Token is invalid, continue as anonymous
                console.log('⚠️ Invalid token, creating anonymous ad');
            }
        }

        // For anonymous ads, validate contact info
        if (!user_id) {
            if (!seller_info || !seller_info.contact) {
                return res.status(400).json({ error: 'Contact information is required for anonymous ads' });
            }
            actual_seller_info = seller_info;
        }

        // Start transaction
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Create ad
            const adResult = await client.query(`
                INSERT INTO ads (title, description, price, category_id, user_id, location, is_urgent, seller_info)
                VVALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING *
            `, [title, description, price, category_id, user_id, location, is_urgent || false, actual_seller_info]);

            const ad = adResult.rows[0];

            // Save photos as Base64
            if (photos && photos.length > 0) {
                for (let i = 0; i < photos.length; i++) {
                    const photoData = photos[i];
                    
                    // Validate Base64 format
                    if (!photoData.startsWith('data:image/')) {
                        throw new Error('Invalid image format');
                    }
                    
                    await client.query(`
                        INSERT INTO ad_photos (ad_id, image_data, display_order)
                        VALUES ($1, $2, $3)
                    `, [ad.id, photoData, i]);
                }
            }

            await client.query('COMMIT');

            console.log('✅ Ad created:', title, user_id ? '(by user)' : '(anonymous)');

            // Send notification to Telegram for support ads
            if (user_id) {
                try {
                    const userResult = await pool.query(
                        'SELECT full_name, email FROM users WHERE id = $1',
                        [user_id]
                    );
                    if (userResult.rows.length > 0) {
                        const user = userResult.rows[0];
                        await sendToTelegram(
                            `🎮 Новое объявление: ${title}\n💰 Цена: ${price} руб.\n📝 ${description.substring(0, 100)}...`,
                            user
                        );
                    }
                } catch (telegramError) {
                    console.error('Telegram notification failed:', telegramError);
                }
            }

            res.json({
                message: 'Ad created successfully',
                ad: {
                    ...ad,
                    photos: photos
                }
            });

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('❌ Create ad error:', error);
            res.status(500).json({ error: 'Internal server error' });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('❌ Create ad error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Add photos to existing ad
app.post('/api/ads/:id/photos', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { photos = [] } = req.body;
        const user_id = req.user.userId;

        // Check if ad exists and belongs to user
        const adCheck = await pool.query(
            'SELECT id FROM ads WHERE id = $1 AND user_id = $2',
            [id, user_id]
        );

        if (adCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Ad not found or access denied' });
        }

        // Get current photo count
        const photoCountResult = await pool.query(
            'SELECT COUNT(*) FROM ad_photos WHERE ad_id = $1',
            [id]
        );
        const currentCount = parseInt(photoCountResult.rows[0].count);

        if (currentCount + photos.length > 3) {
            return res.status(400).json({ error: 'Maximum 3 photos allowed per ad' });
        }

        // Save new photos as Base64
        for (let i = 0; i < photos.length; i++) {
            const photoData = photos[i];
            
            // Validate Base64 format
            if (!photoData.startsWith('data:image/')) {
                return res.status(400).json({ error: 'Invalid image format' });
            }
            
            await pool.query(`
                INSERT INTO ad_photos (ad_id, image_data, display_order)
                VALUES ($1, $2, $3)
            `, [id, photoData, currentCount + i]);
        }

        console.log(`📸 Added ${photos.length} photos to ad ${id}`);

        res.json({
            message: 'Photos uploaded successfully',
            photos: photos
        });
    } catch (error) {
        console.error('❌ Upload photos error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete photo
app.delete('/api/ads/:id/photos/:photoId', authenticateToken, async (req, res) => {
    try {
        const { id, photoId } = req.params;
        const user_id = req.user.userId;

        // Check if ad exists and belongs to user
        const adCheck = await pool.query(
            'SELECT id FROM ads WHERE id = $1 AND user_id = $2',
            [id, user_id]
        );

        if (adCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Ad not found or access denied' });
        }

        // Delete from database
        await pool.query(
            'DELETE FROM ad_photos WHERE id = $1 AND ad_id = $2',
            [photoId, id]
        );

        console.log(`🗑️  Deleted photo ${photoId} from ad ${id}`);

        res.json({ message: 'Photo deleted successfully' });
    } catch (error) {
        console.error('❌ Delete photo error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Favorites routes
app.get('/api/favorites', authenticateToken, async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const offset = (page - 1) * limit;
        const user_id = req.user.userId;

        const result = await pool.query(`
            SELECT 
                a.*,
                u.username as seller_username,
                u.full_name as seller_name,
                u.rating as seller_rating,
                c.name as category_name,
                c.icon as category_icon,
                COUNT(*) OVER() as total_count,
                (SELECT image_data FROM ad_photos WHERE ad_id = a.id ORDER BY display_order LIMIT 1) as main_image
            FROM favorites f
            JOIN ads a ON f.ad_id = a.id
            LEFT JOIN users u ON a.user_id = u.id
            LEFT JOIN categories c ON a.category_id = c.id
            WHERE f.user_id = $1 AND a.is_active = TRUE
            ORDER BY f.created_at DESC
            LIMIT $2 OFFSET $3
        `, [user_id, limit, offset]);

        console.log(`❤️  Loaded ${result.rows.length} favorites for user ${user_id}`);

        res.json({
            ads: result.rows.map(ad => ({
                id: ad.id,
                title: ad.title,
                description: ad.description,
                price: ad.price,
                category: ad.category_name,
                location: ad.location,
                isUrgent: ad.is_urgent,
                isFavorite: true,
                seller: {
                    username: ad.seller_username,
                    name: ad.seller_name,
                    rating: ad.seller_rating
                },
                image: ad.main_image || null,
                time: formatTimeAgo(ad.created_at),
                views: ad.views
            })),
            total: result.rows[0]?.total_count || 0
        });
    } catch (error) {
        console.error('❌ Get favorites error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/favorites/:adId', authenticateToken, async (req, res) => {
    try {
        const { adId } = req.params;
        const user_id = req.user.userId;

        // Check if ad exists
        const adCheck = await pool.query('SELECT id FROM ads WHERE id = $1 AND is_active = TRUE', [adId]);
        if (adCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Ad not found' });
        }

        await pool.query(`
            INSERT INTO favorites (user_id, ad_id)
            VALUES ($1, $2)
            ON CONFLICT (user_id, ad_id) DO NOTHING
        `, [user_id, adId]);

        console.log(`❤️  Ad ${adId} added to favorites by user ${user_id}`);

        res.json({ message: 'Added to favorites' });
    } catch (error) {
        console.error('❌ Add favorite error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/favorites/:adId', authenticateToken, async (req, res) => {
    try {
        const { adId } = req.params;
        const user_id = req.user.userId;

        await pool.query(`
            DELETE FROM favorites 
            WHERE user_id = $1 AND ad_id = $2
        `, [user_id, adId]);

        console.log(`💔 Ad ${adId} removed from favorites by user ${user_id}`);

        res.json({ message: 'Removed from favorites' });
    } catch (error) {
        console.error('❌ Remove favorite error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Categories routes
app.get('/api/categories', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, name, icon, 
                   (SELECT COUNT(*) FROM ads WHERE category_id = categories.id AND is_active = TRUE) as ad_count
            FROM categories 
            ORDER BY name
        `);

        res.json(result.rows);
    } catch (error) {
        console.error('❌ Get categories error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Messages routes
app.get('/api/messages/chats', authenticateToken, async (req, res) => {
    try {
        const user_id = req.user.userId;

        const result = await pool.query(`
            SELECT 
                c.id,
                CASE 
                    WHEN c.user1_id = $1 THEN u2.username
                    ELSE u1.username
                END as name,
                CASE 
                    WHEN c.user1_id = $1 THEN u2.id
                    ELSE u1.id
                END as contact_id,
                c.last_message,
                c.last_message_time,
                c.unread_count,
                'user' as type,
                CASE 
                    WHEN c.user1_id = $1 THEN u2.id
                    ELSE u1.id
                END != $1 as is_online
            FROM chats c
            LEFT JOIN users u1 ON c.user1_id = u1.id
            LEFT JOIN users u2 ON c.user2_id = u2.id
            WHERE c.user1_id = $1 OR c.user2_id = $1
            ORDER BY c.last_message_time DESC
        `, [user_id]);

        // Add support chat
        const supportChat = {
            id: 'support',
            name: 'Поддержка Zeeptook',
            contact_id: 'support',
            last_message: 'Здравствуйте! Чем могу помочь?',
            last_message_time: new Date(),
            unread_count: 0,
            type: 'support',
            is_online: true
        };
        result.rows.unshift(supportChat);

        console.log(`💬 Loaded ${result.rows.length} chats for user ${user_id}`);

        res.json(result.rows);
    } catch (error) {
        console.error('❌ Get chats error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/messages/chat/:chatId', authenticateToken, async (req, res) => {
    try {
        const { chatId } = req.params;
        const user_id = req.user.userId;

        if (chatId === 'support' || chatId.startsWith('support_')) {
            // ИСПОЛЬЗУЕМ НОВУЮ ТАБЛИЦУ support_messages
            let actualChatId = chatId;
            
            // Если общий чат поддержки, ищем все чаты пользователя
            if (chatId === 'support') {
                const result = await pool.query(`
                    SELECT 
                        sm.*,
                        u.username as sender_username,
                        u.full_name as sender_name
                    FROM support_messages sm
                    LEFT JOIN users u ON sm.user_id = u.id
                    WHERE sm.user_id = $1
                    ORDER BY sm.created_at ASC
                `, [user_id]);

                // Если нет сообщений, возвращаем приветственное сообщение
                if (result.rows.length === 0) {
                    const welcomeMessage = {
                        id: 'support_welcome',
                        sender_id: 1, // Admin ID
                        content: 'Здравствуйте! Чем могу помочь?',
                        chat_type: 'support',
                        created_at: new Date(),
                        sender_username: 'Поддержка'
                    };
                    return res.json([welcomeMessage]);
                }

                return res.json(result.rows);
            } else {
                // Конкретный чат поддержки
                const result = await pool.query(`
                    SELECT 
                        sm.*,
                        u.username as sender_username,
                        u.full_name as sender_name
                    FROM support_messages sm
                    LEFT JOIN users u ON sm.user_id = u.id
                    WHERE sm.chat_id = $1
                    ORDER BY sm.created_at ASC
                `, [actualChatId]);

                return res.json(result.rows);
            }
        } else {
            // Остальной код для обычных чатов остается без изменений...
            const chatCheck = await pool.query(
                'SELECT user1_id, user2_id FROM chats WHERE id = $1',
                [chatId]
            );

            if (chatCheck.rows.length === 0) {
                return res.status(404).json({ error: 'Chat not found' });
            }

            const chat = chatCheck.rows[0];
            const otherUserId = chat.user1_id === user_id ? chat.user2_id : chat.user1_id;

            const result = await pool.query(`
                SELECT 
                    m.*,
                    u.username as sender_username
                FROM messages m
                LEFT JOIN users u ON m.sender_id = u.id
                WHERE (m.sender_id = $1 AND m.receiver_id = $2)
                   OR (m.sender_id = $2 AND m.receiver_id = $1)
                ORDER BY m.created_at ASC
            `, [user_id, otherUserId]);

            res.json(result.rows);
        }
    } catch (error) {
        console.error('❌ Get chat messages error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// ОТПРАВКА СООБЩЕНИЙ В ЧАТ ПОДДЕРЖКИ (НОВАЯ ТАБЛИЦА)
app.post('/api/messages/support', authenticateToken, async (req, res) => {
    try {
        const { message, content, chatId } = req.body; 
        const sender_id = req.user.userId;

        // Берем текст из любого доступного поля
        const finalContent = message || content;

        if (!finalContent) {
            return res.status(400).json({ error: 'Сообщение не может быть пустым' });
        }

        // 1. Получаем данные пользователя для Телеграма
        const userResult = await pool.query(
            'SELECT id, username, email, full_name FROM users WHERE id = $1',
            [sender_id]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }

        const user = userResult.rows[0];
        let actualChatId = chatId;
        
        // Если chatId не указан, создаем новый
        if (!actualChatId || actualChatId === 'support') {
            actualChatId = `support_${sender_id}_${Date.now()}`;
        }

        // 2. ЗАПИСЬ В НОВУЮ ТАБЛИЦУ support_messages
        const dbResult = await pool.query(`
            INSERT INTO support_messages (user_id, content, chat_id, is_from_admin)
            VALUES ($1, $2, $3, false)
            RETURNING *
        `, [sender_id, finalContent, actualChatId]);

        // 3. ОТПРАВКА В TELEGRAM
        const telegramSent = await sendToTelegram(finalContent, {
            userId: user.id,
            email: user.email,
            name: user.full_name || user.username,
            chatId: actualChatId
        }, 'support');

        res.json({
            success: true,
            message: 'Сообщение отправлено в поддержку',
            data: dbResult.rows[0],
            telegramSent,
            chatId: actualChatId
        });

    } catch (error) {
        console.error('❌ Ошибка поддержки:', error);
        res.status(500).json({ error: 'Ошибка сервера', details: error.message });
    }
});


// Эндпоинт для получения сообщений от Telegram бота (webhook или API)
app.post('/api/telegram/webhook', async (req, res) => {
    try {
        console.log('🤖 Telegram webhook received:', req.body);
        
        const { message } = req.body;
        
        if (!message) {
            return res.status(400).json({ error: 'No message in request' });
        }
        
        const { chat, text, from } = message;
        
        // Проверяем, что сообщение из нужного чата поддержки
        if (!TELEGRAM_CHAT_ID || chat.id.toString() !== TELEGRAM_CHAT_ID.toString()) {
            console.log('❌ Message from unauthorized chat:', chat.id);
            return res.status(403).json({ error: 'Unauthorized chat' });
        }
        
        // Извлекаем ID пользователя из сообщения
        // Формат: "🆘 НОВОЕ СООБЩЕНИЕ В ЧАТ ПОДДЕРЖКИ\n👤 ID пользователя: 123\n..."
        const userIdMatch = text.match(/ID пользователя:\s*(\d+)/);
        
        if (!userIdMatch) {
            console.log('❌ No user ID found in message');
            return res.json({ success: false, error: 'No user ID' });
        }
        
        const userId = userIdMatch[1];
        
        // Если оператор отвечает в Telegram (отправляет ответное сообщение)
        // Проверяем, что это ответ на сообщение пользователя, а не системное уведомление
        if (text.includes('👤 Ответ оператора:')) {
            // Получаем текст ответа оператора
            const responseMatch = text.match(/👤 Ответ оператора:\s*(.+)/s);
            if (responseMatch) {
                const operatorResponse = responseMatch[1].trim();
                
                // Сохраняем сообщение от оператора в базу
                await pool.query(`
                    INSERT INTO support_messages (user_id, admin_id, content, chat_id, is_from_admin)
                    VALUES ($1, $2, $3, $4, true)
                `, [userId, 1, operatorResponse, `support_${userId}`]);
                
                console.log(`✅ Operator response saved for user ${userId}`);
            }
        }
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('❌ Telegram webhook error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// Регулярные сообщения
app.post('/api/messages', authenticateToken, async (req, res) => {
    try {
        const { chat_id, content, receiver_id, ad_id } = req.body;
        const sender_id = req.user.userId;

        if (!content) {
            return res.status(400).json({ error: 'Message content is required' });
        }

        let actual_receiver_id = receiver_id;
        let actual_chat_id = chat_id;

        // Handle support messages
        if (chat_id === 'support') {
            actual_receiver_id = 1; // Admin user ID
            actual_chat_id = null;
            
            // Получаем информацию о пользователе
            const userResult = await pool.query(
                'SELECT full_name, email FROM users WHERE id = $1',
                [sender_id]
            );
            
            if (userResult.rows.length > 0) {
                const user = userResult.rows[0];
                // Отправляем в Telegram
                await sendToTelegram(content, {
                    userId: sender_id,
                    email: user.email,
                    name: user.full_name,
                    chatId: `support_${sender_id}`
                }, 'support');
            }
        }

        const result = await pool.query(`
            INSERT INTO messages (sender_id, receiver_id, ad_id, content)
            VALUES ($1, $2, $3, $4)
            RETURNING *
        `, [sender_id, actual_receiver_id, ad_id, content]);

        // Update chat last message if it's a regular chat
        if (actual_chat_id && actual_chat_id !== 'support') {
            await pool.query(`
                UPDATE chats 
                SET last_message = $1, last_message_time = CURRENT_TIMESTAMP, unread_count = unread_count + 1
                WHERE id = $2
            `, [content, actual_chat_id]);
        }

        console.log(`💬 Message sent from ${sender_id} to ${actual_receiver_id}`);

        res.json({
            message: 'Message sent successfully',
            message: result.rows[0]
        });
    } catch (error) {
        console.error('❌ Send message error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Инициализация чата поддержки для пользователя
app.post('/api/messages/support/init', authenticateToken, async (req, res) => {
    try {
        const user_id = req.user.userId;

        // Получаем информацию о пользователе
        const userResult = await pool.query(
            'SELECT id, username, email, full_name FROM users WHERE id = $1',
            [user_id]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = userResult.rows[0];
        const chatId = generateSupportChatId(user_id);

        // Создаем приветственное сообщение от поддержки
        await pool.query(`
            INSERT INTO messages (sender_id, receiver_id, content, chat_type, chat_id)
            VALUES ($1, $2, $3, $4, $5)
        `, [1, user_id, 'Здравствуйте! Чем могу помочь?', 'support', chatId]);

        console.log(`🆕 Support chat initialized for user ${user_id} (chatId: ${chatId})`);

        res.json({
            success: true,
            chatId: chatId,
            message: 'Support chat initialized'
        });
    } catch (error) {
        console.error('❌ Init support chat error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Profile routes
app.get('/api/profile', authenticateToken, async (req, res) => {
    console.log('🔍 /api/profile called for user:', req.user.userId);
    
    try {
        const user_id = req.user.userId;

        // Проверяем подключение к БД
        console.log('📊 Querying user with ID:', user_id);
        
        const userResult = await pool.query(`
            SELECT id, username, email, full_name, avatar_url, rating, created_at
            FROM users WHERE id = $1
        `, [user_id]);

        console.log('📊 User query result:', userResult.rows.length, 'rows');
        
        if (userResult.rows.length === 0) {
            console.log('❌ User not found in database');
            return res.status(404).json({ error: 'User not found' });
        }

        console.log('📊 User found:', userResult.rows[0].email);
        
        const adsResult = await pool.query(`
            SELECT COUNT(*) as total_ads,
                   COUNT(CASE WHEN is_active = TRUE THEN 1 END) as active_ads
            FROM ads WHERE user_id = $1
        `, [user_id]);

        console.log('📊 Ads stats:', adsResult.rows[0]);

        const favoritesResult = await pool.query(`
            SELECT COUNT(*) as total_favorites
            FROM favorites WHERE user_id = $1
        `, [user_id]);

        console.log('📊 Favorites stats:', favoritesResult.rows[0]);

        console.log(`👤 Profile loaded for user ${user_id}`);

        res.json({
            user: userResult.rows[0],
            stats: {
                total_ads: parseInt(adsResult.rows[0].total_ads || 0),
                active_ads: parseInt(adsResult.rows[0].active_ads || 0),
                total_favorites: parseInt(favoritesResult.rows[0].total_favorites || 0)
            }
        });
    } catch (error) {
        console.error('❌ Get profile error DETAILS:', error);
        console.error('❌ Error stack:', error.stack);
        res.status(500).json({ error: 'Internal server error: ' + error.message });
    }
});

// Update profile
app.put('/api/profile', authenticateToken, async (req, res) => {
    try {
        const user_id = req.user.userId;
        const { full_name, avatar_url, birth_year } = req.body;

        // Валидация года рождения
        if (birth_year) {
            const currentYear = new Date().getFullYear();
            if (birth_year < 1900 || birth_year > currentYear) {
                return res.status(400).json({ error: 'Укажите корректный год рождения' });
            }
        }

        const result = await pool.query(`
            UPDATE users 
            SET full_name = $1, avatar_url = $2, birth_year = $3, updated_at = CURRENT_TIMESTAMP
            WHERE id = $4
            RETURNING id, username, email, full_name, avatar_url, rating
        `, [full_name, avatar_url, user_id]);

        console.log(`✏️  Profile updated for user ${user_id}`);

        res.json({
            message: 'Profile updated successfully',
            user: result.rows[0]
        });
    } catch (error) {
        console.error('❌ Update profile error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// User's ads
app.get('/api/profile/ads', authenticateToken, async (req, res) => {
    try {
        const user_id = req.user.userId;
        const { page = 1, limit = 20 } = req.query;
        const offset = (page - 1) * limit;

        const result = await pool.query(`
            SELECT 
                a.*,
                c.name as category_name,
                (SELECT image_data FROM ad_photos WHERE ad_id = a.id ORDER BY display_order LIMIT 1) as main_image,
                COUNT(*) OVER() as total_count
            FROM ads a
            LEFT JOIN categories c ON a.category_id = c.id
            WHERE a.user_id = $1
            ORDER BY a.created_at DESC
            LIMIT $2 OFFSET $3
        `, [user_id, limit, offset]);

        res.json({
            ads: result.rows.map(ad => ({
                id: ad.id,
                title: ad.title,
                description: ad.description,
                price: ad.price,
                category: ad.category_name,
                location: ad.location,
                isUrgent: ad.is_urgent,
                isActive: ad.is_active,
                image: ad.main_image || null,
                time: formatTimeAgo(ad.created_at),
                views: ad.views
            })),
            total: result.rows[0]?.total_count || 0,
            page: parseInt(page),
            totalPages: Math.ceil((result.rows[0]?.total_count || 0) / limit)
        });
    } catch (error) {
        console.error('❌ Get user ads error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});
 

// ============================================
// === WEB SOCKET CHAT & DEAL ROUTES ===
// ============================================

// 1. Получение списка чатов пользователя
app.get('/api/chats', authenticateToken, async (req, res) => {
    try {
        const user_id = req.user.userId;
        console.log(`💬 Loading chats for user: ${user_id}`);
        
        const result = await pool.query(`
            SELECT 
                c.id,
                -- Определяем имя собеседника
                CASE 
                    WHEN c.user1_id = $1 THEN u2.full_name
                    ELSE u1.full_name
                END as name,
                -- Определяем ID собеседника
                CASE 
                    WHEN c.user1_id = $1 THEN u2.id
                    ELSE u1.id
                END as other_user_id,
                -- Определяем username собеседника
                CASE 
                    WHEN c.user1_id = $1 THEN u2.username
                    ELSE u1.username
                END as other_username,
                -- Последнее сообщение
                COALESCE(m.content, 'Чат создан') as last_message,
                COALESCE(m.created_at, c.created_at) as last_message_time,
                -- Непрочитанные сообщения
                COALESCE((
                    SELECT COUNT(*) 
                    FROM messages m2 
                    WHERE m2.chat_id = c.id 
                    AND m2.sender_id != $1 
                    AND m2.is_read = FALSE
                ), 0) as unread_count,
                -- Информация о сделке
                COALESCE(c.has_deal, FALSE) as has_deal,
                c.deal_id,
                -- Тип чата
                CASE 
                    WHEN c.deal_id IS NOT NULL THEN 'deal' 
                    ELSE 'regular' 
                END as type,
                -- ID объявления
                c.ad_id,
                -- Время создания
                c.created_at,
                c.updated_at
            FROM chats c
            LEFT JOIN users u1 ON c.user1_id = u1.id
            LEFT JOIN users u2 ON c.user2_id = u2.id
            LEFT JOIN LATERAL (
                SELECT content, created_at
                FROM messages
                WHERE chat_id = c.id
                ORDER BY created_at DESC
                LIMIT 1
            ) m ON true
            -- КРИТИЧНО: пользователь должен быть одним из двух участников
            WHERE (c.user1_id = $1 OR c.user2_id = $1)
            -- И оба пользователя должны существовать
            AND u1.id IS NOT NULL AND u2.id IS NOT NULL
            ORDER BY COALESCE(m.created_at, c.created_at) DESC
        `, [user_id]);
        
        console.log(`✅ Loaded ${result.rows.length} chats for user ${user_id}`);
        
        // Дополнительная проверка на стороне сервера
        const validChats = result.rows.filter(chat => {
            // Убеждаемся, что other_user_id не равен текущему пользователю
            return chat.other_user_id && parseInt(chat.other_user_id) !== parseInt(user_id);
        });
        
        res.json(validChats);
        
    } catch (error) {
        console.error('❌ Get chats error:', error);
        console.error('❌ Error details:', error.message);
        res.status(500).json({ 
            error: 'Internal server error',
            details: error.message 
        });
    }
});

// 2. Создание нового чата
app.post('/api/chats/create', authenticateToken, async (req, res) => {
    try {
        const user_id = req.user.userId;
        const { other_user_id, ad_id } = req.body;
        
        console.log(`💬 Creating/loading chat: user=${user_id}, seller=${other_user_id}, ad=${ad_id}`);
        
        // ВАЖНОЕ ИСПРАВЛЕНИЕ: Проверяем, что пользователь существует
        if (!other_user_id || isNaN(parseInt(other_user_id))) {
            return res.status(400).json({ error: 'Необходимо указать корректный ID продавца' });
        }
        
        // Приводим к числам для сравнения
        const userIdNum = parseInt(user_id);
        const otherUserIdNum = parseInt(other_user_id);
        
        if (userIdNum === otherUserIdNum) {
            return res.status(400).json({ error: 'Вы не можете создать чат с самим собой' });
        }
        
        // Проверяем существование пользователя
        const otherUserCheck = await pool.query(
            'SELECT id, username, full_name FROM users WHERE id = $1',
            [otherUserIdNum]
        );
        
        if (otherUserCheck.rows.length === 0) {
            console.error(`❌ User ${otherUserIdNum} not found`);
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        
        // Определяем порядок ID пользователей для единообразия
        const user1_id = Math.min(userIdNum, otherUserIdNum);
        const user2_id = Math.max(userIdNum, otherUserIdNum);
        
        console.log(`🔍 Checking for chat between ${user1_id} and ${user2_id}`);
        
        // Ищем существующий чат с правильным порядком
        const existingChat = await pool.query(`
            SELECT id FROM chats 
            WHERE user1_id = $1 AND user2_id = $2
        `, [user1_id, user2_id]);
        
        if (existingChat.rows.length > 0) {
            // Возвращаем существующий чат
            const chatId = existingChat.rows[0].id;
            console.log(`✅ Found existing chat: ${chatId}`);
            
            return res.json({ 
                success: true,
                chatId: chatId, 
                existed: true,
                sellerId: otherUserIdNum,
                adId: ad_id 
            });
        }
        
        // Создаем новый чат с ПРАВИЛЬНЫМ порядком ID
        const result = await pool.query(`
            INSERT INTO chats (user1_id, user2_id, ad_id, created_at)
            VALUES ($1, $2, $3, NOW())
            RETURNING id
        `, [user1_id, user2_id, ad_id]);
        
        const newChatId = result.rows[0].id;
        console.log(`✅ Created new chat ${newChatId} between ${user1_id} and ${user2_id}`);
        
        // Определяем, кто из пользователей является создателем (инициатором чата)
        const initiatorId = userIdNum; // Текущий авторизованный пользователь
        const receiverId = otherUserIdNum; // Второй участник
        
        // Создаем приветственное сообщение (системное)
        const otherUser = otherUserCheck.rows[0];
        const welcomeMessage = `👋 Привет! Вы начали общение с ${otherUser.full_name || otherUser.username || 'пользователем'}`;
        
        await pool.query(`
            INSERT INTO messages (chat_id, sender_id, receiver_id, content, is_system, created_at)
            VALUES ($1, $2, $3, $4, TRUE, NOW())
        `, [newChatId, initiatorId, receiverId, welcomeMessage]);
        
        // Отправляем уведомление в Telegram (если настроено)
        try {
            const userInfo = await pool.query(
                'SELECT full_name, email FROM users WHERE id = $1',
                [userIdNum]
            );
            
            if (userInfo.rows.length > 0 && TELEGRAM_BOT_TOKEN) {
                await sendToTelegram(
                    `💬 НОВЫЙ ЧАТ ПО ОБЪЯВЛЕНИЮ\n` +
                    `👤 Покупатель: ${userInfo.rows[0]?.full_name || 'Неизвестно'}\n` +
                    `📧 Email: ${userInfo.rows[0]?.email || 'Не указан'}\n` +
                    `👥 Участники: ${user1_id} ↔ ${user2_id}\n` +
                    `🆔 Chat ID: ${newChatId}`,
                    otherUserCheck.rows[0],
                    'support'
                );
            }
        } catch (telegramError) {
            console.error('Telegram notification failed:', telegramError);
        }
        
        res.json({ 
            success: true,
            chatId: newChatId, 
            existed: false,
            sellerId: otherUserIdNum,
            adId: ad_id 
        });
        
    } catch (error) {
        console.error('❌ Create chat error:', error);
        
        // Проверяем специфические ошибки
        if (error.code === '23505') { // unique_violation (дубликат)
            console.log('⚠️ Chat already exists, trying to find it...');
            try {
                const user_id = req.user.userId;
                const { other_user_id, ad_id } = req.body;
                
                const userIdNum = parseInt(user_id);
                const otherUserIdNum = parseInt(other_user_id);
                const user1_id = Math.min(userIdNum, otherUserIdNum);
                const user2_id = Math.max(userIdNum, otherUserIdNum);
                
                const existingChat = await pool.query(`
                    SELECT id FROM chats 
                    WHERE user1_id = $1 AND user2_id = $2
                `, [user1_id, user2_id]);
                
                if (existingChat.rows.length > 0) {
                    return res.json({ 
                        success: true,
                        chatId: existingChat.rows[0].id, 
                        existed: true,
                        sellerId: otherUserIdNum,
                        adId: ad_id 
                    });
                }
            } catch (findError) {
                console.error('Error finding existing chat:', findError);
            }
        }
        
        res.status(500).json({ 
            success: false,
            error: 'Ошибка создания чата',
            details: error.message 
        });
    }
});

// 4. Отправка сообщения
app.post('/api/messages/send', authenticateToken, async (req, res) => {
    try {
        const user_id = req.user.userId;
        const { chatId, content, receiverId } = req.body;
        
        if (!chatId || !content) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        // Проверяем доступ к чату
        const chatCheck = await pool.query(`
            SELECT id, user1_id, user2_id FROM chats 
            WHERE id = $1 AND (user1_id = $2 OR user2_id = $2)
        `, [chatId, user_id]);
        
        if (chatCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        // Сохраняем сообщение
        const result = await pool.query(`
            INSERT INTO messages (chat_id, sender_id, receiver_id, content)
            VALUES ($1, $2, $3, $4)
            RETURNING *, (SELECT full_name FROM users WHERE id = $2) as sender_name
        `, [chatId, user_id, receiverId, content]);
        
        // Обновляем последнее сообщение в чате
        await pool.query(`
            UPDATE chats 
            SET last_message_id = $1, updated_at = NOW()
            WHERE id = $2
        `, [result.rows[0].id, chatId]);
        
        res.json(result.rows[0]);
        
    } catch (error) {
        console.error('Send message error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 5. Запрос оператора
app.post('/api/chats/:chatId/request-operator', authenticateToken, async (req, res) => {
    try {
        const { chatId } = req.params;
        const user_id = req.user.userId;
        
        // Проверяем доступ к чату
        const chat = await pool.query(`
            SELECT * FROM chats 
            WHERE id = $1 AND (user1_id = $2 OR user2_id = $2)
        `, [chatId, user_id]);
        
        if (chat.rows.length === 0) {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        // Создаем запрос на оператора
        await pool.query(`
            INSERT INTO operator_requests (chat_id, requester_id, status)
            VALUES ($1, $2, 'pending')
            ON CONFLICT (chat_id) DO UPDATE 
            SET status = 'pending', updated_at = NOW()
        `, [chatId, user_id]);
        
        // Добавляем согласие текущего пользователя
        await pool.query(`
            INSERT INTO operator_agreements (chat_id, user_id, agreed)
            VALUES ($1, $2, TRUE)
            ON CONFLICT (chat_id, user_id) DO UPDATE
            SET agreed = TRUE, agreed_at = NOW()
        `, [chatId, user_id]);
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Request operator error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 6. Получение статуса согласия
app.get('/api/chats/:chatId/agreement-status', authenticateToken, async (req, res) => {
    try {
        const { chatId } = req.params;
        const user_id = req.user.userId;
        
        const result = await pool.query(`
            SELECT 
                oa.user_id,
                oa.agreed,
                c.user1_id,
                c.user2_id
            FROM operator_agreements oa
            JOIN chats c ON oa.chat_id = c.id
            WHERE oa.chat_id = $1
        `, [chatId]);
        
        const agreements = {};
        result.rows.forEach(row => {
            agreements[row.user_id] = row.agreed;
        });
        
        const otherUserId = result.rows[0]?.user1_id === user_id ? 
            result.rows[0]?.user2_id : result.rows[0]?.user1_id;
        
        res.json({
            agreements,
            other_party_agreed: agreements[otherUserId] || false
        });
        
    } catch (error) {
        console.error('Get agreement status error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 7. Согласие на оператора
app.post('/api/chats/:chatId/agree-operator', authenticateToken, async (req, res) => {
    try {
        const { chatId } = req.params;
        const user_id = req.user.userId;
        
        await pool.query(`
            INSERT INTO operator_agreements (chat_id, user_id, agreed)
            VALUES ($1, $2, TRUE)
            ON CONFLICT (chat_id, user_id) DO UPDATE
            SET agreed = TRUE, agreed_at = NOW()
        `, [chatId, user_id]);
        
        // Проверяем, согласны ли оба пользователя
        const agreements = await pool.query(`
            SELECT COUNT(*) as agreed_count
            FROM operator_agreements 
            WHERE chat_id = $1 AND agreed = TRUE
        `, [chatId]);
        
        if (agreements.rows[0].agreed_count === 2) {
            // Оба согласны - создаем сделку
            await createDealForChat(chatId);
        }
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Agree operator error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 8. Функция создания сделки
async function createDealForChat(chatId) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Получаем информацию о чате
        const chat = await client.query(`
            SELECT c.*, a.title, a.price, a.id as ad_id
            FROM chats c
            LEFT JOIN ads a ON c.ad_id = a.id
            WHERE c.id = $1
        `, [chatId]);
        
        if (chat.rows.length === 0) throw new Error('Chat not found');
        
        const chatData = chat.rows[0];
        const dealCode = generateDealCode();
        
        // Создаем сделку
        const deal = await client.query(`
            INSERT INTO deals (
                deal_code, title, price, ad_id, 
                buyer_id, seller_id, chat_id, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
            RETURNING *
        `, [
            dealCode,
            chatData.title || 'Сделка',
            chatData.price || 0,
            chatData.ad_id,
            chatData.user1_id,
            chatData.user2_id,
            chatId
        ]);
        
        // Обновляем чат
        await client.query(`
            UPDATE chats 
            SET has_deal = TRUE, deal_id = $1
            WHERE id = $2
        `, [deal.rows[0].id, chatId]);
        
        // Назначаем оператора
        const operator = await client.query(`
            SELECT id FROM users_operator 
            WHERE is_active = TRUE 
            ORDER BY RANDOM() 
            LIMIT 1
        `);
        
        if (operator.rows.length > 0) {
            await client.query(`
                UPDATE deals 
                SET operator_id = $1, status = 'active'
                WHERE id = $2
            `, [operator.rows[0].id, deal.rows[0].id]);
        }
        
        await client.query('COMMIT');
        
        // Отправляем уведомление через WebSocket
        broadcastDealCreated(chatId, deal.rows[0]);
        
        return deal.rows[0];
        
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

// 9. Получение информации о сделке
app.get('/api/deals/:dealId', authenticateToken, async (req, res) => {
    try {
        const { dealId } = req.params;
        const user_id = req.user.userId;
        
        const result = await pool.query(`
            SELECT 
                d.*,
                u1.full_name as buyer_name,
                u2.full_name as seller_name,
                op.full_name as operator_name,
                a.title as ad_title
            FROM deals d
            LEFT JOIN users u1 ON d.buyer_id = u1.id
            LEFT JOIN users u2 ON d.seller_id = u2.id
            LEFT JOIN users_operator op ON d.operator_id = op.id
            LEFT JOIN ads a ON d.ad_id = a.id
            WHERE d.id = $1 AND (d.buyer_id = $2 OR d.seller_id = $2 OR d.operator_id = $2)
        `, [dealId, user_id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Deal not found' });
        }
        
        res.json(result.rows[0]);
        
    } catch (error) {
        console.error('Get deal error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 10. Получение сообщений сделки
app.get('/api/deals/:dealId/messages', authenticateToken, async (req, res) => {
    try {
        const { dealId } = req.params;
        const user_id = req.user.userId;
        
        // Проверяем доступ к сделке
        const dealCheck = await pool.query(`
            SELECT id FROM deals 
            WHERE id = $1 AND (buyer_id = $2 OR seller_id = $2 OR operator_id = $2)
        `, [dealId, user_id]);
        
        if (dealCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        const result = await pool.query(`
            SELECT 
                dm.*,
                CASE 
                    WHEN dm.sender_type = 'user' THEN u.full_name
                    WHEN dm.sender_type = 'operator' THEN op.full_name
                    ELSE 'Система'
                END as sender_name,
                CASE 
                    WHEN dm.sender_type = 'operator' THEN 'operator'
                    ELSE 'user'
                END as sender_role
            FROM deal_messages dm
            LEFT JOIN users u ON dm.sender_id = u.id AND dm.sender_type = 'user'
            LEFT JOIN users_operator op ON dm.sender_id = op.id AND dm.sender_type = 'operator'
            WHERE dm.deal_id = $1
            ORDER BY dm.created_at ASC
        `, [dealId]);
        
        res.json(result.rows);
        
    } catch (error) {
        console.error('Get deal messages error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 11. Отправка сообщения в сделку
app.post('/api/deals/:dealId/messages', authenticateToken, async (req, res) => {
    try {
        const { dealId } = req.params;
        const user_id = req.user.userId;
        const { content } = req.body;
        
        // Проверяем доступ и определяем тип отправителя
        const deal = await pool.query(`
            SELECT 
                d.*,
                CASE 
                    WHEN d.buyer_id = $2 THEN 'buyer'
                    WHEN d.seller_id = $2 THEN 'seller'
                    WHEN d.operator_id = $2 THEN 'operator'
                    ELSE NULL
                END as user_role
            FROM deals d
            WHERE d.id = $1 AND (d.buyer_id = $2 OR d.seller_id = $2 OR d.operator_id = $2)
        `, [dealId, user_id]);
        
        if (deal.rows.length === 0) {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        const dealData = deal.rows[0];
        const senderType = dealData.user_role === 'operator' ? 'operator' : 'user';
        
        // Сохраняем сообщение
        const result = await pool.query(`
            INSERT INTO deal_messages (deal_id, sender_id, sender_type, content)
            VALUES ($1, $2, $3, $4)
            RETURNING *, $5 as sender_name
        `, [dealId, user_id, senderType, content, req.user.username]);
        
        res.json(result.rows[0]);
        
    } catch (error) {
        console.error('Send deal message error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 12. Получение участников сделки
app.get('/api/deals/:dealId/participants', authenticateToken, async (req, res) => {
    try {
        const { dealId } = req.params;
        
        const result = await pool.query(`
            SELECT 
                u.id,
                u.full_name as name,
                u.avatar_url,
                'buyer' as role,
                EXISTS (
                    SELECT 1 FROM connections c 
                    WHERE c.user_id = u.id AND c.last_seen > NOW() - INTERVAL '5 minutes'
                ) as is_online
            FROM deals d
            JOIN users u ON d.buyer_id = u.id
            WHERE d.id = $1
            
            UNION ALL
            
            SELECT 
                u.id,
                u.full_name as name,
                u.avatar_url,
                'seller' as role,
                EXISTS (
                    SELECT 1 FROM connections c 
                    WHERE c.user_id = u.id AND c.last_seen > NOW() - INTERVAL '5 minutes'
                ) as is_online
            FROM deals d
            JOIN users u ON d.seller_id = u.id
            WHERE d.id = $1
            
            UNION ALL
            
            SELECT 
                op.id,
                op.full_name as name,
                NULL as avatar_url,
                'operator' as role,
                TRUE as is_online
            FROM deals d
            JOIN users_operator op ON d.operator_id = op.id
            WHERE d.id = $1 AND d.operator_id IS NOT NULL
        `, [dealId]);
        
        res.json(result.rows);
        
    } catch (error) {
        console.error('Get participants error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 13. Изменение статуса сделки (для оператора)
app.put('/api/operator/deals/:dealId/status', async (req, res) => {
    try {
        const { dealId } = req.params;
        const { status } = req.body;
        const authHeader = req.headers['authorization'];
        
        if (!authHeader) {
            return res.status(401).json({ error: 'Token required' });
        }
        
        // Проверяем оператора
        const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
        const decoded = Buffer.from(token, 'base64').toString();
        const [operatorId] = decoded.split(':');
        
        const operatorCheck = await pool.query(`
            SELECT id FROM users_operator WHERE id = $1 AND is_active = TRUE
        `, [operatorId]);
        
        if (operatorCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Operator not found' });
        }
        
        // Обновляем статус
        await pool.query(`
            UPDATE deals 
            SET status = $1, updated_at = NOW()
            WHERE id = $2 AND operator_id = $3
            RETURNING *
        `, [status, dealId, operatorId]);
        
        // Добавляем системное сообщение
        await pool.query(`
            INSERT INTO deal_messages (deal_id, sender_type, content)
            VALUES ($1, 'system', 'Статус сделки изменен на: ' || $2)
        `, [dealId, status]);
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Update deal status error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Функция для трансляции созданной сделки
function broadcastDealCreated(chatId, deal) {
    connections.forEach((ws, userId) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'operator_joined',
                chatId: chatId,
                deal: deal
            }));
        }
    });
}

// Функция для рассылки изменения статуса
function broadcastStatusChange(data, dealId) {
    const message = {
        type: 'status_change',
        dealId: dealId,
        status: data.status
    };
    
    const dealWs = dealConnections.get(dealId);
    if (dealWs) {
        dealWs.forEach((ws, userId) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(message));
            }
        });
    }
}

// ============================================
// === SIMPLE OPERATOR AUTH & ROUTES ===
// ============================================

// Простой логин для таблицы users_operator
app.post('/api/operator/simple-login', async (req, res) => {
    try {
        const { username, password } = req.body;

        console.log('🔐 Simple operator login attempt:', username);

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }

        // Проверяем в таблице users_operator
        const result = await pool.query(
            `SELECT id, username, email, full_name, role 
             FROM users_operator 
             WHERE username = $1 AND password = $2 AND is_active = TRUE`,
            [username, password]
        );

        if (result.rows.length === 0) {
            console.log('❌ Invalid operator credentials for:', username);
            return res.status(401).json({ error: 'Invalid operator credentials' });
        }

        const operator = result.rows[0];
        
        // Создаем простой токен (base64)
        const simpleToken = Buffer.from(`${operator.id}:${Date.now()}`).toString('base64');
        
        console.log(`✅ Operator logged in: ${operator.username} (id: ${operator.id})`);

        res.json({
            success: true,
            message: 'Login successful',
            token: simpleToken,
            operator: {
                id: operator.id,
                username: operator.username,
                email: operator.email,
                full_name: operator.full_name,
                role: operator.role
            }
        });

    } catch (error) {
        console.error('❌ Simple operator login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Простая проверка оператора (без JWT)
app.post('/api/operator/simple-verify', async (req, res) => {
    try {
        const { token, operatorId } = req.body;

        if (!token || !operatorId) {
            return res.json({ success: false, error: 'Token and operatorId required' });
        }

        // Просто проверяем существование оператора
        const result = await pool.query(
            `SELECT id, username, email, full_name, role 
             FROM users_operator 
             WHERE id = $1 AND is_active = TRUE`,
            [operatorId]
        );

        if (result.rows.length === 0) {
            return res.json({ success: false, error: 'Operator not found' });
        }

        res.json({
            success: true,
            operator: result.rows[0]
        });

    } catch (error) {
        console.error('❌ Simple verify error:', error);
        res.json({ success: false, error: 'Database error' });
    }
});

// ============================================
// === ДЛЯ ОБРАТНОЙ СОВМЕСТИМОСТИ СО СТАРЫМ HTML ===
// ============================================

// Старый эндпоинт входа (для совместимости с существующим HTML)
app.post('/api/operator/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        console.log('🔐 Legacy operator login attempt:', username);

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }

        // Проверяем в таблице users_operator
        const result = await pool.query(
            `SELECT id, username, email, full_name, role 
             FROM users_operator 
             WHERE username = $1 AND password = $2 AND is_active = TRUE`,
            [username, password]
        );

        if (result.rows.length === 0) {
            console.log('❌ Invalid operator credentials for:', username);
            return res.status(401).json({ error: 'Invalid operator credentials' });
        }

        const operator = result.rows[0];
        
        // Используем тот же простой токен (base64)
        const simpleToken = Buffer.from(`${operator.id}:${Date.now()}`).toString('base64');
        
        console.log(`✅ Operator logged in (legacy endpoint): ${operator.username}`);

        res.json({
            success: true,
            message: 'Login successful',
            token: simpleToken, // Отправляем простой токен
            operator: {
                id: operator.id,
                username: operator.username,
                email: operator.email,
                full_name: operator.full_name,
                role: operator.role
            }
        });

    } catch (error) {
        console.error('❌ Legacy operator login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Старый эндпоинт проверки (для совместимости с существующим HTML)
app.get('/api/operator/verify', async (req, res) => {
    try {
        const authHeader = req.headers['authorization'];
        
        if (!authHeader) {
            return res.status(401).json({ error: 'Token required' });
        }

        // Извлекаем токен из заголовка
        const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
        
        if (!token) {
            return res.status(401).json({ error: 'Token required' });
        }

        // Простой токен в формате base64(id:timestamp)
        try {
            const decoded = Buffer.from(token, 'base64').toString();
            const [operatorId] = decoded.split(':');
            
            if (!operatorId) {
                return res.status(403).json({ error: 'Invalid token format' });
            }

            // Проверяем существование оператора
            const result = await pool.query(
                `SELECT id, username, email, full_name, role 
                 FROM users_operator 
                 WHERE id = $1 AND is_active = TRUE`,
                [operatorId]
            );

            if (result.rows.length === 0) {
                return res.status(403).json({ error: 'Operator not found' });
            }

            res.json({
                success: true,
                operator: result.rows[0]
            });

        } catch (decodeError) {
            console.error('❌ Token decode error:', decodeError);
            return res.status(403).json({ error: 'Invalid token' });
        }

    } catch (error) {
        console.error('❌ Legacy verify error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Простой дашборд для оператора (использует реальные данные из БД)
app.get('/api/operator/simple-dashboard', async (req, res) => {
    try {
        const { operatorId } = req.query;

        if (!operatorId) {
            return res.status(400).json({ error: 'Operator ID is required' });
        }

        // Проверяем оператора
        const operatorResult = await pool.query(
            `SELECT id, username, email, full_name, role 
             FROM users_operator 
             WHERE id = $1 AND is_active = TRUE`,
            [operatorId]
        );

        if (operatorResult.rows.length === 0) {
            return res.status(404).json({ error: 'Operator not found' });
        }

        const operator = operatorResult.rows[0];

        // Получаем статистику из БД
        const statsQuery = await pool.query(`
            SELECT 
                COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
                COUNT(CASE WHEN status = 'active' THEN 1 END) as active,
                COUNT(CASE WHEN status = 'payment' THEN 1 END) as payment,
                COUNT(CASE WHEN status = 'transfer' THEN 1 END) as transfer,
                COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
                COUNT(CASE WHEN status = 'disputed' THEN 1 END) as disputed,
                COUNT(CASE WHEN is_urgent = TRUE THEN 1 END) as urgent
            FROM operator_deals 
            WHERE operator_id = $1
        `, [operatorId]);

        const today = new Date().toISOString().split('T')[0];
        const todayStats = await pool.query(`
            SELECT 
                COUNT(*) as deals_today,
                COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_today
            FROM operator_deals 
            WHERE operator_id = $1 
            AND DATE(created_at) = $2
        `, [operatorId, today]);

        const stats = statsQuery.rows[0] || {
            pending: 0,
            active: 0,
            payment: 0,
            transfer: 0,
            completed: 0,
            disputed: 0,
            urgent: 0
        };

        // Последние сделки
        const recentDeals = await pool.query(`
            SELECT 
                od.*,
                u1.username as buyer_username,
                u2.username as seller_username
            FROM operator_deals od
            LEFT JOIN users u1 ON od.buyer_id = u1.id
            LEFT JOIN users u2 ON od.seller_id = u2.id
            WHERE od.operator_id = $1
            ORDER BY od.created_at DESC
            LIMIT 5
        `, [operatorId]);

        res.json({
            success: true,
            stats: {
                pending: parseInt(stats.pending) || 0,
                active: parseInt(stats.active) || 0,
                payment: parseInt(stats.payment) || 0,
                transfer: parseInt(stats.transfer) || 0,
                completed: parseInt(stats.completed) || 0,
                disputed: parseInt(stats.disputed) || 0,
                urgent: parseInt(stats.urgent) || 0,
                deals_today: parseInt(todayStats.rows[0]?.deals_today) || 0,
                completed_today: parseInt(todayStats.rows[0]?.completed_today) || 0,
                unread: 0 // Можно добавить логику подсчета непрочитанных сообщений
            },
            recent_deals: recentDeals.rows.map(deal => ({
                id: deal.id,
                deal_code: deal.deal_code,
                title: deal.title,
                price: deal.price,
                status: deal.status,
                is_urgent: deal.is_urgent,
                buyer: deal.buyer_username || 'Unknown',
                seller: deal.seller_username || 'Unknown',
                created_at: deal.created_at,
                time_ago: formatTimeAgo(deal.created_at)
            })),
            operator: operator
        });

    } catch (error) {
        console.error('❌ Simple dashboard error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Старый эндпоинт дашборда (для совместимости)
app.get('/api/operator/dashboard', async (req, res) => {
    try {
        const authHeader = req.headers['authorization'];
        
        if (!authHeader) {
            return res.status(401).json({ error: 'Token required' });
        }

        const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
        
        if (!token) {
            return res.status(401).json({ error: 'Token required' });
        }

        // Декодируем токен
        try {
            const decoded = Buffer.from(token, 'base64').toString();
            const [operatorId] = decoded.split(':');
            
            if (!operatorId) {
                return res.status(403).json({ error: 'Invalid token' });
            }

            // Перенаправляем на simple-dashboard
            const response = await fetch(`http://localhost:${PORT}/api/operator/simple-dashboard?operatorId=${operatorId}`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' }
            });
            
            const data = await response.json();
            res.json(data);

        } catch (decodeError) {
            console.error('❌ Token decode error:', decodeError);
            return res.status(403).json({ error: 'Invalid token' });
        }

    } catch (error) {
        console.error('❌ Legacy dashboard error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Простой список сделок (использует реальные данные из БД)
app.get('/api/operator/simple-deals', async (req, res) => {
    try {
        const { operatorId, status = 'all', page = 1, search = '' } = req.query;

        if (!operatorId) {
            return res.status(400).json({ error: 'Operator ID is required' });
        }

        // Проверяем оператора
        const operatorResult = await pool.query(
            `SELECT id, username, email, full_name, role 
             FROM users_operator 
             WHERE id = $1 AND is_active = TRUE`,
            [operatorId]
        );

        if (operatorResult.rows.length === 0) {
            return res.status(404).json({ error: 'Operator not found' });
        }

        // Основной запрос сделок
        let query = `
            SELECT 
                od.*,
                u1.username as buyer_username,
                u1.full_name as buyer_name,
                u2.username as seller_username,
                u2.full_name as seller_name,
                COUNT(*) OVER() as total_count
            FROM operator_deals od
            LEFT JOIN users u1 ON od.buyer_id = u1.id
            LEFT JOIN users u2 ON od.seller_id = u2.id
            WHERE od.operator_id = $1
        `;

        let params = [operatorId];
        let paramCount = 1;

        if (status !== 'all') {
            paramCount++;
            query += ` AND od.status = $${paramCount}`;
            params.push(status);
        }

        if (search) {
            paramCount++;
            query += ` AND (
                od.title ILIKE $${paramCount} OR
                od.deal_code ILIKE $${paramCount} OR
                u1.username ILIKE $${paramCount} OR
                u1.full_name ILIKE $${paramCount} OR
                u2.username ILIKE $${paramCount} OR
                u2.full_name ILIKE $${paramCount}
            )`;
            params.push(`%${search}%`);
        }

        // Пагинация
        const pageInt = parseInt(page);
        const limit = 10;
        const offset = (pageInt - 1) * limit;
        
        query += ` ORDER BY od.created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
        params.push(limit, offset);

        const result = await pool.query(query, params);

        // Статистика по статусам
        const statusStatsQuery = await pool.query(`
            SELECT 
                status,
                COUNT(*) as count
            FROM operator_deals
            WHERE operator_id = $1
            GROUP BY status
        `, [operatorId]);

        const statusStats = { all: 0 };
        statusStatsQuery.rows.forEach(row => {
            statusStats[row.status] = parseInt(row.count);
            statusStats.all += parseInt(row.count);
        });

        res.json({
            success: true,
            deals: result.rows.map(deal => ({
                id: deal.id,
                deal_code: deal.deal_code,
                title: deal.title,
                price: deal.price,
                game: deal.game,
                status: deal.status,
                payment_method: deal.payment_method,
                payment_status: deal.payment_status,
                is_urgent: deal.is_urgent,
                buyer: { 
                    username: deal.buyer_username, 
                    name: deal.buyer_name 
                },
                seller: { 
                    username: deal.seller_username, 
                    name: deal.seller_name 
                },
                created_at: deal.created_at,
                time_ago: formatTimeAgo(deal.created_at),
                unread_count: 0
            })),
            total: parseInt(result.rows[0]?.total_count || 0),
            page: pageInt,
            total_pages: Math.ceil(parseInt(result.rows[0]?.total_count || 0) / limit),
            status_stats: statusStats,
            stats: {
                active: statusStats.active || 0,
                unread: 0
            }
        });

    } catch (error) {
        console.error('❌ Simple deals error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Старый эндпоинт списка сделок (для совместимости)
app.get('/api/operator/deals', async (req, res) => {
    try {
        const authHeader = req.headers['authorization'];
        
        if (!authHeader) {
            return res.status(401).json({ error: 'Token required' });
        }

        const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
        
        if (!token) {
            return res.status(401).json({ error: 'Token required' });
        }

        // Декодируем токен
        try {
            const decoded = Buffer.from(token, 'base64').toString();
            const [operatorId] = decoded.split(':');
            
            if (!operatorId) {
                return res.status(403).json({ error: 'Invalid token' });
            }

            // Перенаправляем на simple-deals
            const { status = 'all', page = 1, search = '' } = req.query;
            const response = await fetch(`http://localhost:${PORT}/api/operator/simple-deals?operatorId=${operatorId}&status=${status}&page=${page}&search=${encodeURIComponent(search)}`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' }
            });
            
            const data = await response.json();
            res.json(data);

        } catch (decodeError) {
            console.error('❌ Token decode error:', decodeError);
            return res.status(403).json({ error: 'Invalid token' });
        }

    } catch (error) {
        console.error('❌ Legacy deals error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Получение деталей сделки (реальные данные из БД)
app.get('/api/operator/simple-deals/:dealId', async (req, res) => {
    try {
        const { dealId } = req.params;
        const { operatorId } = req.query;

        if (!operatorId) {
            return res.status(400).json({ error: 'Operator ID is required' });
        }

        // Проверяем оператора
        const operatorResult = await pool.query(
            `SELECT id, username, email, full_name, role 
             FROM users_operator 
             WHERE id = $1 AND is_active = TRUE`,
            [operatorId]
        );

        if (operatorResult.rows.length === 0) {
            return res.status(404).json({ error: 'Operator not found' });
        }

        // Получаем детали сделки
        const dealQuery = await pool.query(`
            SELECT 
                od.*,
                u1.username as buyer_username,
                u1.full_name as buyer_name,
                u1.email as buyer_email,
                u1.avatar_url as buyer_avatar,
                u2.username as seller_username,
                u2.full_name as seller_name,
                u2.email as seller_email,
                u2.avatar_url as seller_avatar,
                a.title as ad_title,
                a.description as ad_description,
                a.price as ad_price
            FROM operator_deals od
            LEFT JOIN users u1 ON od.buyer_id = u1.id
            LEFT JOIN users u2 ON od.seller_id = u2.id
            LEFT JOIN ads a ON od.ad_id = a.id
            WHERE od.id = $1 AND od.operator_id = $2
        `, [dealId, operatorId]);

        if (dealQuery.rows.length === 0) {
            return res.status(404).json({ error: 'Deal not found or access denied' });
        }

        const deal = dealQuery.rows[0];

        // Получаем сообщения по сделке
        const messagesQuery = await pool.query(`
            SELECT 
                m.*,
                u.username as sender_name
            FROM messages m
            LEFT JOIN users u ON m.sender_id = u.id
            WHERE m.deal_id = $1
            ORDER BY m.created_at ASC
        `, [dealId]);

        res.json({
            success: true,
            deal: {
                id: deal.id,
                deal_code: deal.deal_code,
                title: deal.title,
                description: deal.description,
                price: deal.price,
                game: deal.game,
                status: deal.status,
                payment_method: deal.payment_method,
                payment_status: deal.payment_status,
                is_urgent: deal.is_urgent,
                created_at: deal.created_at,
                updated_at: deal.updated_at
            },
            buyer: {
                id: deal.buyer_id,
                username: deal.buyer_username,
                name: deal.buyer_name,
                email: deal.buyer_email,
                avatar: deal.buyer_avatar
            },
            seller: {
                id: deal.seller_id,
                username: deal.seller_username,
                name: deal.seller_name,
                email: deal.seller_email,
                avatar: deal.seller_avatar
            },
            ad: {
                id: deal.ad_id,
                title: deal.ad_title,
                description: deal.ad_description,
                price: deal.ad_price
            },
            messages: messagesQuery.rows.map(msg => ({
                id: msg.id,
                sender_id: msg.sender_id,
                sender_name: msg.sender_name,
                content: msg.content,
                created_at: msg.created_at,
                time_ago: formatTimeAgo(msg.created_at)
            }))
        });

    } catch (error) {
        console.error('❌ Get deal details error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Debug routes
app.get('/api/debug/database', async (req, res) => {
    try {
        const usersCount = await pool.query('SELECT COUNT(*) as count FROM users');
        const categoriesCount = await pool.query('SELECT COUNT(*) as count FROM categories');
        const adsCount = await pool.query('SELECT COUNT(*) as count FROM ads');
        const activeAdsCount = await pool.query('SELECT COUNT(*) as count FROM ads WHERE is_active = TRUE');
        const photosCount = await pool.query('SELECT COUNT(*) as count FROM ad_photos');
        const messagesCount = await pool.query('SELECT COUNT(*) as count FROM messages');
        
        const sampleAds = await pool.query(`
            SELECT a.id, a.title, a.is_active, c.name as category_name 
            FROM ads a 
            LEFT JOIN categories c ON a.category_id = c.id 
            LIMIT 5
        `);

        // Проверка таблиц оператора
        let operatorUsersCount = { rows: [{ count: 0 }] };
        let operatorDealsCount = { rows: [{ count: 0 }] };
        try {
            operatorUsersCount = await pool.query('SELECT COUNT(*) as count FROM users_operator');
            operatorDealsCount = await pool.query('SELECT COUNT(*) as count FROM operator_deals');
        } catch (error) {
            console.log('⚠️ Operator tables not found or error:', error.message);
        }

        res.json({
            database_status: 'connected',
            tables: {
                users: parseInt(usersCount.rows[0].count),
                categories: parseInt(categoriesCount.rows[0].count),
                ads: {
                    total: parseInt(adsCount.rows[0].count),
                    active: parseInt(activeAdsCount.rows[0].count)
                },
                ad_photos: parseInt(photosCount.rows[0].count),
                messages: parseInt(messagesCount.rows[0].count),
                users_operator: parseInt(operatorUsersCount.rows[0].count),
                operator_deals: parseInt(operatorDealsCount.rows[0].count)
            },
            sample_ads: sampleAds.rows,
            connection_info: {
                database: process.env.DB_NAME || 'from DATABASE_URL',
                host: process.env.DB_HOST || 'from DATABASE_URL'
            },
            telegram_bot: {
                configured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
                bot_token: TELEGRAM_BOT_TOKEN ? '***' + TELEGRAM_BOT_TOKEN.slice(-4) : 'not set',
                chat_id: TELEGRAM_CHAT_ID ? '***' + TELEGRAM_CHAT_ID.slice(-4) : 'not set'
            }
        });
    } catch (error) {
        console.error('❌ Debug endpoint error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ 
            status: 'OK', 
            database: 'connected',
            google_oauth: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
            telegram_bot: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'ERROR', 
            database: 'disconnected',
            google_oauth: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
            telegram_bot: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
            timestamp: new Date().toISOString()
        });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('❌ Unhandled error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

// 404 handler for API routes
app.use('/api/*', (req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
});

// 404 handler for operator pages
app.use('/operator-*', (req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// 404 handler for pages
app.use((req, res) => {
    res.status(404).send('Page not found');
});

// Start server - универсальное решение для локальной разработки и Vercel
if (process.env.NODE_ENV !== 'production' || process.env.VERCEL !== '1') {
    // Локальная разработка или не на Vercel
    async function startServer() {
        console.log('🚀 Starting Zeeptook server...');
        console.log('📁 Environment:', process.env.NODE_ENV || 'development');
        console.log('🏠 Platform:', process.env.VERCEL ? 'Vercel (local development)' : 'Local');
        
        // Проверка конфигурации Telegram
        console.log('🤖 Telegram Bot Configuration:');
        console.log('   Token:', TELEGRAM_BOT_TOKEN ? '***' + TELEGRAM_BOT_TOKEN.slice(-4) : '❌ NOT SET');
        console.log('   Chat ID:', TELEGRAM_CHAT_ID ? '***' + TELEGRAM_CHAT_ID.slice(-4) : '❌ NOT SET');
        
        const dbConnected = await testDatabaseConnection();
        if (!dbConnected) {
            console.error('❌ Cannot start server without database connection');
            process.exit(1);
        }

        try {
            const usersCount = await pool.query('SELECT COUNT(*) as count FROM users');
            const categoriesCount = await pool.query('SELECT COUNT(*) as count FROM categories');
            const adsCount = await pool.query('SELECT COUNT(*) as count FROM ads');
            const photosCount = await pool.query('SELECT COUNT(*) as count FROM ad_photos');
            const messagesCount = await pool.query('SELECT COUNT(*) as count FROM messages');
            
            console.log('📊 Database status:');
            console.log(`   👥 Users: ${parseInt(usersCount.rows[0].count)}`);
            console.log(`   📂 Categories: ${parseInt(categoriesCount.rows[0].count)}`);
            console.log(`   📢 Ads: ${parseInt(adsCount.rows[0].count)}`);
            console.log(`   📸 Photos: ${parseInt(photosCount.rows[0].count)}`);
            console.log(`   💬 Messages: ${parseInt(messagesCount.rows[0].count)}`);
            
            // Проверяем наличие таблиц оператора
            try {
                const operatorUsersCount = await pool.query('SELECT COUNT(*) as count FROM users_operator');
                console.log(`   👮 Operator users: ${parseInt(operatorUsersCount.rows[0].count)}`);
                
                const operatorDealsCount = await pool.query('SELECT COUNT(*) as count FROM operator_deals');
                console.log(`   🤝 Operator deals: ${parseInt(operatorDealsCount.rows[0].count)}`);
                
                if (parseInt(operatorUsersCount.rows[0].count) === 0) {
                    console.log('   ⚠️  No operators found in users_operator table.');
                }
            } catch (tableError) {
                console.log('   ⚠️  Operator tables not found or error accessing them.');
            }
            
        } catch (error) {
            console.error('❌ Error checking database tables:', error);
            console.log('💡 Tip: Make sure all tables are created in your Neon database');
        }
        
        const PORT = process.env.PORT || 3000;
        const server = app.listen(PORT, () => {
            console.log('');
            console.log('🎉 Server started successfully!');
            console.log('📍 Running on http://localhost:' + PORT);
            console.log('');
            console.log('📱 Support chat is ENABLED with Telegram integration');
            console.log('👮 Simple Operator system is ENABLED');
            
            // Сообщение о WebSocket
            if (process.env.VERCEL) {
                console.log('💬 Chat system: Polling (WebSocket disabled on Vercel)');
            } else {
                console.log('💬 WebSocket chat system is ENABLED');
            }
            
            console.log('');
            console.log('🚀 Available operator pages:');
            console.log('   👉 http://localhost:' + PORT + '/operator-login');
            console.log('   👉 http://localhost:' + PORT + '/operator-dashboard');
            console.log('   👉 http://localhost:' + PORT + '/operator-deals');
            console.log('   👉 http://localhost:' + PORT + '/operator-chat');
            console.log('   👉 http://localhost:' + PORT + '/deal-page');
            console.log('   👉 http://localhost:' + PORT + '/operator-profile');
            console.log('');
            console.log('🔧 Simple Operator API endpoints:');
            console.log('   POST   /api/operator/simple-login');
            console.log('   POST   /api/operator/simple-verify');
            console.log('   GET    /api/operator/simple-dashboard');
            console.log('   GET    /api/operator/simple-deals');
            console.log('   GET    /api/operator/simple-deals/:dealId');
            console.log('');
            console.log('💬 Chat API endpoints (using polling):');
            console.log('   GET    /api/chats');
            console.log('   POST   /api/chats/create');
            console.log('   GET    /api/messages/:chatId');
            console.log('   POST   /api/messages/send');
            console.log('   GET    /api/deals/:dealId');
            console.log('   GET    /api/deals/:dealId/messages');
            console.log('   POST   /api/deals/:dealId/messages');
            console.log('');
            
            if (!process.env.VERCEL) {
                console.log('🌐 WebSocket available on ws://localhost:' + PORT);
            } else {
                console.log('📡 Using API polling for real-time updates');
            }
        });

        // WebSocket только для локальной разработки (не на Vercel)
        if (!process.env.VERCEL) {
            try {
                const WebSocket = require('ws');
                const wss = new WebSocket.Server({ noServer: true });
                
                wss.on('connection', (ws, request) => {
                    const url = new URL(request.url, `http://${request.headers.host}`);
                    const userId = url.searchParams.get('userId');
                    
                    console.log(`🔗 WebSocket connected: user ${userId}`);
                    
                    ws.on('message', async (message) => {
                        try {
                            const data = JSON.parse(message);
                            console.log('📨 WebSocket message:', data);
                            
                            // Обработка сообщений
                            if (data.type === 'message') {
                                // Сохраняем в БД
                                const result = await pool.query(`
                                    INSERT INTO messages (sender_id, receiver_id, content, chat_id)
                                    VALUES ($1, $2, $3, $4)
                                    RETURNING id, created_at
                                `, [data.senderId, data.receiverId, data.content, data.chatId]);
                                
                                // Отправляем получателю если подключен
                                wss.clients.forEach(client => {
                                    if (client !== ws && client.readyState === require('ws').WebSocket.OPEN) {
                                        client.send(JSON.stringify({
                                            type: 'new_message',
                                            message: {
                                                id: result.rows[0].id,
                                                sender_id: data.senderId,
                                                content: data.content,
                                                created_at: result.rows[0].created_at
                                            },
                                            chatId: data.chatId
                                        }));
                                    }
                                });
                            }
                        } catch (error) {
                            console.error('WebSocket error:', error);
                        }
                    });
                    
                    ws.on('close', () => {
                        console.log(`🔗 WebSocket disconnected: user ${userId}`);
                    });
                });
                
                server.on('upgrade', (request, socket, head) => {
                    wss.handleUpgrade(request, socket, head, (ws) => {
                        wss.emit('connection', ws, request);
                    });
                });
                
                console.log('✅ WebSocket server enabled');
            } catch (error) {
                console.log('⚠️ WebSocket not available:', error.message);
            }
        } else {
            console.log('⚠️ WebSocket disabled (Vercel deployment)');
        }
    }

    startServer().catch(error => {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    });
} else {
    // Для Vercel продакшена - просто экспортируем app
    console.log('🚀 Vercel production deployment detected');
    console.log('📡 WebSocket disabled, using API polling');
    console.log('✅ Server ready for Vercel Serverless Functions');
    
    module.exports = app;
}
