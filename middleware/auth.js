// middleware/auth.js
// Authentication helpers used by the page routes.
//
//   isLoggedIn - blocks pages for visitors who are not logged in
//   setUser    - exposes the logged-in user to every EJS template as `user`

function isLoggedIn(req, res, next) {
    if (req.session && req.session.user) {
        return next();                  // session exists -> allow the request
    }
    return res.redirect('/login');      // no session -> back to the login page
}

function setUser(req, res, next) {
    res.locals.user = (req.session && req.session.user) ? req.session.user : null;
    next();
}

module.exports = { isLoggedIn, setUser };
