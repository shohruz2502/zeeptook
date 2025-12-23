require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();

// Configuration from .env
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-key-for-development';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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
    res.json({
        success: true,
        googleClientId: GOOGLE_CLIENT_ID || 'not-configured',
        redirectUri: `${req.protocol}://${req.get('host')}`
    });
});

// Обмен authorization code на access token
async function exchangeCodeForToken(code) {
    try {
        console.log('🔄 Exchanging code for token...');
        
        const redirectUri = process.env.NODE_ENV === 'production' 
            ? 'https://zeeptook.vercel.app/register.html' 
            : 'http://localhost:3000/register.html';
        
        const response = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                code: code,
                client_id: GOOGLE_CLIENT_ID,
                client_secret: GOOGLE_CLIENT_SECRET,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code'
            })
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
        if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
            return res.status(503).json({ error: 'Google OAuth is not configured' });
        }

        const { code } = req.body;
        
        if (!code) {
            return res.status(400).json({ error: 'Authorization code is required' });
        }

        console.log('🔐 Google auth attempt with code');

        // Exchange code for tokens
        const tokenData = await exchangeCodeForToken(code);
        const { access_token } = tokenData;

        // Get user info from Google
        const userInfo = await getGoogleUserInfo(access_token);
        if (!userInfo) {
            return res.status(400).json({ error: 'Failed to get user info from Google' });
        }

        console.log('🔐 Google user info:', { 
            email: userInfo.email, 
            name: userInfo.name,
            sub: userInfo.sub 
        });

        // Check if user already exists
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
            
            console.log('✅ Google user logged in:', user.email);

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
            console.log('🆕 New Google user:', userInfo.email);
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

        console.log('🔐 Google complete registration:', { email, username });

        // Валидация
        if (!google_id || !email || !full_name || !username || !password || !birth_year) {
            return res.status(400).json({ error: 'Все обязательные поля должны быть заполнены' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Пароль должен быть не менее 6 символов' });
        }

        const currentYear = new Date().getFullYear();
        if (birth_year < 1900 || birth_year > currentYear) {
            return res.status(400).json({ error: 'Укажите корректный год рождения' });
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
        const result = await pool.query(
            `INSERT INTO users (
                username, email, password, full_name, 
                avatar_url, google_id, auth_method, birth_year
            ) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
             RETURNING id, username, email, full_name, avatar_url, rating, created_at`,
            [username, email, hashedPassword, full_name, 
             avatar_url, google_id, auth_method, birth_year]
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
                created_at: user.created_at
            }
        });

    } catch (error) {
        console.error('❌ Google complete registration error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Auth routes
app.post('/api/register', async (req, res) => {
    try {
        const { 
            username, email, password, full_name, 
            avatar_url, google_id, auth_method = 'email',
            birth_year 
        } = req.body;

        console.log('🔐 Registration attempt:', { username, email, auth_method });

        // For Google auth, username is optional
        if (auth_method === 'email' && (!username || !password)) {
            return res.status(400).json({ error: 'Username and password are required for email registration' });
        }

        if (!email || !full_name) {
            return res.status(400).json({ error: 'Email and full name are required' });
        }

        // Проверка года рождения
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
                avatar_url, google_id, auth_method, birth_year
            ) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
             RETURNING id, username, email, full_name, avatar_url, rating, created_at`,
            [actualUsername, email, hashedPassword, full_name, 
             avatar_url, google_id, auth_method, birth_year]
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
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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

        if (chatId === 'support') {
            // Return support messages from database
            const result = await pool.query(`
                SELECT 
                    m.*,
                    u.username as sender_username
                FROM messages m
                LEFT JOIN users u ON m.sender_id = u.id
                WHERE (m.sender_id = $1 OR m.receiver_id = $1) 
                   AND m.chat_type = 'support'
                ORDER BY m.created_at ASC
            `, [user_id]);

            // Если нет сообщений, возвращаем приветственное сообщение
            if (result.rows.length === 0) {
                const welcomeMessage = {
                    id: 'support_welcome',
                    sender_id: 1, // Admin ID
                    receiver_id: user_id,
                    content: 'Здравствуйте! Чем могу помочь?',
                    chat_type: 'support',
                    created_at: new Date(),
                    sender_username: 'Поддержка'
                };
                result.rows.push(welcomeMessage);
            }

            res.json(result.rows);
        } else {
            // Return regular chat messages
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

// ОТПРАВКА СООБЩЕНИЙ В ЧАТ ПОДДЕРЖКИ
app.post('/api/messages/support', authenticateToken, async (req, res) => {
    try {
        const { content, chatId } = req.body;
        const sender_id = req.user.userId;

        if (!content) {
            return res.status(400).json({ error: 'Message content is required' });
        }

        // Получаем информацию о пользователе
        const userResult = await pool.query(
            'SELECT id, username, email, full_name FROM users WHERE id = $1',
            [sender_id]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = userResult.rows[0];

        // Генерируем chatId, если его нет
        const actualChatId = chatId || generateSupportChatId(sender_id);

        // Сохраняем сообщение в базу данных
        const messageResult = await pool.query(`
            INSERT INTO messages (sender_id, receiver_id, content, chat_type, chat_id)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
        `, [sender_id, 1, content, 'support', actualChatId]);

        const savedMessage = messageResult.rows[0];

        // Отправляем сообщение в Telegram
        const telegramSent = await sendToTelegram(content, {
            userId: user.id,
            email: user.email,
            name: user.full_name || user.username,
            chatId: actualChatId
        }, 'support');

        if (!telegramSent) {
            console.warn('⚠️ Failed to send message to Telegram, but saved to database');
        }

        console.log(`💬 Support message sent from user ${sender_id} (chatId: ${actualChatId})`);

        res.json({
            message: 'Support message sent successfully',
            savedMessage,
            chatId: actualChatId,
            telegramSent
        });

    } catch (error) {
        console.error('❌ Send support message error:', error);
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
            RETURNING id, username, email, full_name, avatar_url, rating, birth_year
        `, [full_name, avatar_url, birth_year, user_id]);

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
        
        // Создаем простой токен (без JWT)
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
                unread_count: 0 // Можно добавить логику подсчета непрочитанных сообщений
            })),
            total: parseInt(result.rows[0]?.total_count || 0),
            page: pageInt,
            total_pages: Math.ceil(parseInt(result.rows[0]?.total_count || 0) / limit),
            status_stats: statusStats,
            stats: {
                active: statusStats.active || 0,
                unread: 0 // Можно добавить логику подсчета непрочитанных сообщений
            }
        });

    } catch (error) {
        console.error('❌ Simple deals error:', error);
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

// Start server
if (process.env.NODE_ENV !== 'production') {
    async function startServer() {
        console.log('🚀 Starting Zeeptook server in development mode...');
        console.log('📁 Environment:', process.env.NODE_ENV || 'development');
        
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
        
        app.listen(PORT, () => {
            console.log('');
            console.log('🎉 Server started successfully!');
            console.log('📍 Running on http://localhost:' + PORT);
            console.log('');
            console.log('📱 Support chat is ENABLED with Telegram integration');
            console.log('👮 Simple Operator system is ENABLED');
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
        });
    }

    startServer().catch(error => {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    });
}

// Export for Vercel
module.exports = app;
