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

// Поддержка как DATABASE_URL (для Vercel + Neon), так и отдельных переменных
let poolConfig;

if (process.env.DATABASE_URL) {
  // Используем DATABASE_URL от Neon
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
  // Используем отдельные переменные (для разработки)
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

// Обновите проверку переменных окружения
const requiredEnvVars = ['JWT_SECRET'];
if (!process.env.DATABASE_URL && !process.env.DB_USER) {
  requiredEnvVars.push('DATABASE_URL or DB_USER, DB_HOST, DB_NAME, DB_PASSWORD');
}

const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0 && process.env.NODE_ENV === 'production') {
    console.error('❌ Missing required environment variables:', missingEnvVars.join(', '));
    console.error('💡 Please check your environment variables in Vercel');
} else if (missingEnvVars.length > 0) {
    console.warn('⚠️ Missing environment variables in development:', missingEnvVars.join(', '));
}

if (!GOOGLE_CLIENT_ID) {
    console.warn('⚠️  GOOGLE_CLIENT_ID not set - Google OAuth will be disabled');
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
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

// Initialize database tables
async function initializeDatabase() {
    try {
        // Users table with Google OAuth support
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255),
                full_name VARCHAR(100),
                phone VARCHAR(20),
                birth_year INTEGER,
                avatar_url VARCHAR(255),
                google_id VARCHAR(100) UNIQUE,
                rating DECIMAL(3,2) DEFAULT 5.0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Categories table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS categories (
                id SERIAL PRIMARY KEY,
                name VARCHAR(50) NOT NULL,
                icon VARCHAR(50),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Ads table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ads (
                id SERIAL PRIMARY KEY,
                title VARCHAR(200) NOT NULL,
                description TEXT,
                price DECIMAL(12,2),
                category_id INTEGER REFERENCES categories(id),
                user_id INTEGER REFERENCES users(id),
                location VARCHAR(100),
                image_urls TEXT[],
                is_urgent BOOLEAN DEFAULT FALSE,
                is_active BOOLEAN DEFAULT TRUE,
                views INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Favorites table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS favorites (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                ad_id INTEGER REFERENCES ads(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, ad_id)
            )
        `);

        // Messages table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                sender_id INTEGER REFERENCES users(id),
                receiver_id INTEGER REFERENCES users(id),
                ad_id INTEGER REFERENCES ads(id),
                content TEXT NOT NULL,
                is_read BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Chats table for managing chats
        await pool.query(`
            CREATE TABLE IF NOT EXISTS chats (
                id SERIAL PRIMARY KEY,
                user1_id INTEGER REFERENCES users(id),
                user2_id INTEGER REFERENCES users(id),
                ad_id INTEGER REFERENCES ads(id),
                last_message TEXT,
                last_message_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                unread_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Insert default categories
        const categoriesResult = await pool.query('SELECT COUNT(*) FROM categories');
        if (parseInt(categoriesResult.rows[0].count) === 0) {
            await pool.query(`
                INSERT INTO categories (name, icon) VALUES 
                ('Электроника', 'fa-laptop'),
                ('Недвижимость', 'fa-home'),
                ('Авто', 'fa-car'),
                ('Работа', 'fa-briefcase'),
                ('Услуги', 'fa-cogs'),
                ('Мебель', 'fa-couch'),
                ('Одежда', 'fa-tshirt'),
                ('Спорт', 'fa-futbol-o'),
                ('Хобби', 'fa-music'),
                ('Животные', 'fa-paw')
            `);
            console.log('✅ Default categories inserted');
        }

        // Create default admin user
        const usersResult = await pool.query('SELECT COUNT(*) FROM users WHERE username = $1', ['admin']);
        if (parseInt(usersResult.rows[0].count) === 0) {
            const hashedPassword = await bcrypt.hash('admin123', 10);
            await pool.query(`
                INSERT INTO users (username, email, password, full_name, phone) 
                VALUES ('admin', 'admin@zeeptook.ru', $1, 'Администратор', '+79990000000')
            `, [hashedPassword]);
            console.log('✅ Admin user created');
        }

        console.log('✅ Database initialized successfully');
    } catch (error) {
        console.error('❌ Error initializing database:', error);
        // Не прерываем выполнение в production
        if (process.env.NODE_ENV !== 'production') {
            throw error;
        }
    }
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

// Auth routes
app.post('/api/register', async (req, res) => {
    try {
        const { 
            username, email, password, full_name, phone, birth_year, 
            avatar_url, google_id, auth_method = 'email' 
        } = req.body;

        console.log('🔐 Registration attempt:', { username, email, auth_method });

        // For Google auth, username is optional
        if (auth_method === 'email' && (!username || !password)) {
            return res.status(400).json({ error: 'Username and password are required for email registration' });
        }

        if (!email || !full_name || !phone) {
            return res.status(400).json({ error: 'Email, full name and phone are required' });
        }

        // Check if user exists
        let userExists;
        if (google_id) {
            userExists = await pool.query(
                'SELECT id FROM users WHERE google_id = $1 OR email = $2',
                [google_id, email]
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
            `INSERT INTO users (username, email, password, full_name, phone, birth_year, avatar_url, google_id) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
             RETURNING id, username, email, full_name, phone, birth_year, avatar_url, rating, created_at`,
            [actualUsername, email, hashedPassword, full_name, phone, birth_year, avatar_url, google_id]
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
                phone: user.phone,
                birth_year: user.birth_year,
                rating: user.rating,
                avatar_url: user.avatar_url,
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
                phone: user.phone,
                birth_year: user.birth_year,
                rating: user.rating,
                avatar_url: user.avatar_url
            }
        });
    } catch (error) {
        console.error('❌ Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Google OAuth endpoint
app.post('/api/auth/google', async (req, res) => {
    try {
        if (!GOOGLE_CLIENT_ID) {
            return res.status(503).json({ error: 'Google OAuth is not configured' });
        }

        const { credential } = req.body;
        
        if (!credential) {
            return res.status(400).json({ error: 'Google credential is required' });
        }

        // Simple JWT verification
        function decodeJWT(token) {
            try {
                const base64Url = token.split('.')[1];
                const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
                const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
                    return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
                }).join(''));
                return JSON.parse(jsonPayload);
            } catch (error) {
                console.error('❌ JWT decode error:', error);
                return null;
            }
        }

        const payload = decodeJWT(credential);
        if (!payload) {
            return res.status(400).json({ error: 'Invalid Google token' });
        }

        const googleId = payload.sub;
        const email = payload.email;
        const name = payload.name;
        const picture = payload.picture;

        console.log('🔐 Google auth attempt:', { email, name, googleId });

        // Check if user already exists
        const userResult = await pool.query(
            'SELECT * FROM users WHERE google_id = $1 OR email = $2',
            [googleId, email]
        );

        if (userResult.rows.length > 0) {
            // User exists - login
            const user = userResult.rows[0];
            const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET);
            
            console.log('✅ Google user logged in:', user.email);

            return res.json({
                exists: true,
                token,
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    full_name: user.full_name,
                    phone: user.phone,
                    birth_year: user.birth_year,
                    rating: user.rating,
                    avatar_url: user.avatar_url
                }
            });
        } else {
            // New user - return user data for additional info
            console.log('🆕 New Google user:', email);
            return res.json({
                exists: false,
                user: {
                    google_id: googleId,
                    email: email,
                    full_name: name,
                    avatar_url: picture,
                    email_verified: payload.email_verified
                }
            });
        }

    } catch (error) {
        console.error('❌ Google auth error:', error);
        res.status(500).json({ error: 'Google authentication failed' });
    }
});

// Ads routes
app.get('/api/ads', async (req, res) => {
    try {
        const { page = 1, limit = 20, category, search } = req.query;
        const offset = (page - 1) * limit;

        let query = `
            SELECT 
                a.*,
                u.username as seller_username,
                u.full_name as seller_name,
                u.rating as seller_rating,
                c.name as category_name,
                c.icon as category_icon,
                COUNT(*) OVER() as total_count
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
                image: ad.image_urls && ad.image_urls.length > 0 ? ad.image_urls[0] : null,
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

        const result = await pool.query(`
            SELECT 
                a.*,
                u.username as seller_username,
                u.full_name as seller_name,
                u.rating as seller_rating,
                u.phone as seller_phone,
                u.created_at as seller_since,
                c.name as category_name
            FROM ads a
            LEFT JOIN users u ON a.user_id = u.id
            LEFT JOIN categories c ON a.category_id = c.id
            WHERE a.id = $1 AND a.is_active = TRUE
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Ad not found' });
        }

        const ad = result.rows[0];

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
            imageUrls: ad.image_urls || [],
            seller: {
                id: ad.user_id,
                username: ad.seller_username,
                name: ad.seller_name,
                rating: ad.seller_rating,
                phone: ad.seller_phone,
                since: formatTimeAgo(ad.seller_since)
            },
            time: formatTimeAgo(ad.created_at)
        });
    } catch (error) {
        console.error('❌ Get ad error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/ads', authenticateToken, async (req, res) => {
    try {
        const { title, description, price, category_id, location, image_urls, is_urgent } = req.body;
        const user_id = req.user.userId;

        // Validation
        if (!title || !description || !category_id) {
            return res.status(400).json({ error: 'Title, description and category are required' });
        }

        const result = await pool.query(`
            INSERT INTO ads (title, description, price, category_id, user_id, location, image_urls, is_urgent)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
        `, [title, description, price, category_id, user_id, location, image_urls || [], is_urgent || false]);

        console.log('✅ Ad created:', title);

        res.json({
            message: 'Ad created successfully',
            ad: result.rows[0]
        });
    } catch (error) {
        console.error('❌ Create ad error:', error);
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
                COUNT(*) OVER() as total_count
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
                image: ad.image_urls && ad.image_urls.length > 0 ? ad.image_urls[0] : null,
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

        // Add support chat if no chats exist
        if (result.rows.length === 0) {
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
            result.rows.push(supportChat);
        }

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
            // Return support messages
            const result = await pool.query(`
                SELECT 
                    m.*,
                    u.username as sender_username
                FROM messages m
                LEFT JOIN users u ON m.sender_id = u.id
                WHERE (m.sender_id = $1 AND m.receiver_id = 1) 
                   OR (m.sender_id = 1 AND m.receiver_id = $1)
                ORDER BY m.created_at ASC
            `, [user_id]);

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

app.post('/api/messages/support', authenticateToken, async (req, res) => {
    try {
        const { user_id } = req.body;

        // Create initial support message
        await pool.query(`
            INSERT INTO messages (sender_id, receiver_id, content)
            VALUES (1, $1, 'Здравствуйте! Чем могу помочь?')
        `, [user_id]);

        console.log(`🆕 Support chat created for user ${user_id}`);

        res.json({ message: 'Support chat created successfully' });
    } catch (error) {
        console.error('❌ Create support chat error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Profile routes
app.get('/api/profile', authenticateToken, async (req, res) => {
    try {
        const user_id = req.user.userId;

        const userResult = await pool.query(`
            SELECT id, username, email, full_name, phone, birth_year, avatar_url, rating, created_at
            FROM users WHERE id = $1
        `, [user_id]);

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const adsResult = await pool.query(`
            SELECT COUNT(*) as total_ads,
                   COUNT(CASE WHEN is_active = TRUE THEN 1 END) as active_ads
            FROM ads WHERE user_id = $1
        `, [user_id]);

        const favoritesResult = await pool.query(`
            SELECT COUNT(*) as total_favorites
            FROM favorites WHERE user_id = $1
        `, [user_id]);

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
        console.error('❌ Get profile error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update profile
app.put('/api/profile', authenticateToken, async (req, res) => {
    try {
        const user_id = req.user.userId;
        const { full_name, phone, birth_year, avatar_url } = req.body;

        const result = await pool.query(`
            UPDATE users 
            SET full_name = $1, phone = $2, birth_year = $3, avatar_url = $4, updated_at = CURRENT_TIMESTAMP
            WHERE id = $5
            RETURNING id, username, email, full_name, phone, birth_year, avatar_url, rating
        `, [full_name, phone, birth_year, avatar_url, user_id]);

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

// Health check endpoint
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ 
            status: 'OK', 
            database: 'connected',
            google_oauth: !!GOOGLE_CLIENT_ID,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'ERROR', 
            database: 'disconnected',
            google_oauth: !!GOOGLE_CLIENT_ID,
            timestamp: new Date().toISOString()
        });
    }
});

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

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('❌ Unhandled error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

// 404 handler for API routes
app.use('/api/*', (req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
});

// 404 handler for pages
app.use((req, res) => {
    res.status(404).send('Page not found');
});

// Start server только в development
if (process.env.NODE_ENV !== 'production') {
    async function startServer() {
        console.log('🚀 Starting Zeeptook server in development mode...');
        console.log('📁 Environment:', process.env.NODE_ENV || 'development');
        
        // Test database connection first
        const dbConnected = await testDatabaseConnection();
        if (!dbConnected) {
            console.error('❌ Cannot start server without database connection');
            process.exit(1);
        }

        // Initialize database
        await initializeDatabase();
        
        app.listen(PORT, () => {
            console.log('');
            console.log('🎉 Server started successfully!');
            console.log('📍 Running on http://localhost:' + PORT);
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
