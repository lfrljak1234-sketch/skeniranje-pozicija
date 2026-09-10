require('dotenv').config();
const express = require('express');
const path = require('path');
const skeniranjeRouter = require('./routes/skeniranje');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/', skeniranjeRouter);

app.get('/', (req, res) => res.redirect('/skeniranje.html'));

// Sigurnosna mreža: ako bilo koja API ruta baci neočekivanu grešku koju nismo
// sami uhvatili, vrati JSON (a ne Expressovu default HTML stranicu s greškom)
// - inače frontend dobije "<!DOCTYPE..." umjesto JSON-a i puca.
app.use('/api', (err, req, res, next) => {
  console.error('Neuhvaćena greška na API ruti:', err);
  res.status(500).json({ error: err.message || 'Nepoznata greška na serveru.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Aplikacija radi na http://localhost:${PORT}`);
});
