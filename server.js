require('dotenv').config();
const express = require('express');
const session = require('express-session');

const { connectDB } = require('./db/db');
const { setUser, isLoggedIn } = require('./middleware/auth');
const authRoutes = require('./routes/auth');

const app = express();
const port = process.env.PORT || 3000;

// ---------------------------------------------------------------- middleware
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

// Session middleware. It must be registered BEFORE any route that uses
// req.session, and before the authentication routes.
app.use(session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 2          // the session expires after 2 hours
    }
}));

// Make the logged-in user available to every template as `user`
app.use(setUser);

// ------------------------------------------------------------------- routes
app.use(authRoutes);                        // /login /register /logout

app.get('/', (req, res) => {
    res.redirect(req.session.user ? '/books' : '/login');
});

// Temporary stand-in for the catalogue page. It is replaced by P4's
// views/list.ejs once that template exists.
// NOTE: isLoggedIn is attached to this single route only, never app-wide,
// so the RESTful API under /api stays public as the specification requires.
app.get('/books', isLoggedIn, (req, res) => {
    res.send('<h1>Catalog (placeholder)</h1>' +
             '<p>Logged in as ' + req.session.user.name + '</p>' +
             '<a href="/logout">Logout</a>');
});

// 404 handler - always the last middleware
app.use((req, res) => {
    res.status(404).send('404 - Unknown request: ' + req.path);
});

// -------------------------------------------------------------------- start
async function startServer() {
    if (!process.env.MONGO_URI) {
        console.error('MONGO_URI is missing. Create a .env file (see .env.example).');
        process.exit(1);
    }
    await connectDB();
    app.listen(port, () => {
        console.log('Server running at http://localhost:' + port);
    });
}
startServer();
