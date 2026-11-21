// routes/auth.js
// Authentication routes: login, registration and logout.
//
//   GET  /login     - show the login form
//   POST /login     - verify the credentials and start a session
//   GET  /register  - show the registration form
//   POST /register  - create a new account
//   GET  /logout    - destroy the session

const express = require('express');
const bcrypt = require('bcrypt');
const { getDB } = require('../db/db');

const router = express.Router();
const SALT_ROUNDS = 10;             // bcrypt cost factor

// ---------------------------------------------------------------- login page
router.get('/login', (req, res) => {
    if (req.session.user) {
        return res.redirect('/books');      // already logged in
    }
    res.render('login', { error: null });
});

// ------------------------------------------------------------- login handler
router.post('/login', async (req, res) => {
    const body = req.body || {};
    const username = (body.username || '').trim();
    const password = body.password || '';

    // 1. both fields are required
    if (!username || !password) {
        return res.status(400).render('login', { error: 'Please fill in both fields.' });
    }

    try {
        const db = getDB();
        const user = await db.collection('users').findOne({ username });

        // 2. compare the submitted password with the stored hash
        //    (the same message is used for "unknown user" and "wrong password")
        const matched = user && await bcrypt.compare(password, user.passwordHash);
        if (!matched) {
            return res.status(401).render('login', { error: 'Invalid username or password.' });
        }

        // 3. store only the information the pages need - never the password hash.
        //    `_id` is included so the REST API can record loans against this user
        //    (see lib/apiAuth.js and services/loanService.js).
        req.session.user = {
            _id: user._id,
            username: user.username,
            name: user.name,
            role: user.role
        };
        return res.redirect('/books');
    } catch (err) {
        console.error('Login error:', err);
        return res.status(500).render('login', { error: 'Server error, please try again.' });
    }
});

// ------------------------------------------------------------- register page
router.get('/register', (req, res) => {
    res.render('register', { error: null });
});

// ---------------------------------------------------------- register handler
router.post('/register', async (req, res) => {
    const body = req.body || {};
    const username = (body.username || '').trim();
    const name = (body.name || '').trim();
    const password = body.password || '';

    if (!username || !name || !password) {
        return res.status(400).render('register', { error: 'All fields are required.' });
    }
    if (password.length < 6) {
        return res.status(400).render('register', { error: 'Password must be at least 6 characters.' });
    }

    try {
        const db = getDB();

        // `users` has no unique index on username yet, so check for duplicates here
        const existing = await db.collection('users').findOne({ username });
        if (existing) {
            return res.status(409).render('register', { error: 'That username is already taken.' });
        }

        const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
        await db.collection('users').insertOne({
            username,
            passwordHash,
            name,
            role: 'member'              // self-registered accounts are never librarians
        });

        return res.redirect('/login');
    } catch (err) {
        console.error('Register error:', err);
        return res.status(500).render('register', { error: 'Server error, please try again.' });
    }
});

// --------------------------------------------------------------------- exit
router.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Logout error:', err);
        }
        res.clearCookie('connect.sid');     // remove the browser-side session cookie
        res.redirect('/login');
    });
});

module.exports = router;
