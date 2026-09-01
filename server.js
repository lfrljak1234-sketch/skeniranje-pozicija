require('dotenv').config();
const express = require('express');
const path = require('path');
const skeniranjeRouter = require('./routes/skeniranje');

const app = express();

app.use(express.static(path.join(__dirname, 'public')));
app.use('/', skeniranjeRouter);

app.get('/', (req, res) => res.redirect('/skeniranje.html'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Aplikacija radi na http://localhost:${PORT}`);
});
