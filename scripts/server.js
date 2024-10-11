require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

const HighScoreSchema = new mongoose.Schema({
  playerName: String,
  score: Number,
  date: { type: Date, default: Date.now }
});

const HighScore = mongoose.model('HighScore', HighScoreSchema);

app.post('/api/highscores', async (req, res) => {
  const { playerName, score } = req.body;
  const newHighScore = new HighScore({ playerName, score });
  await newHighScore.save();
  res.json(newHighScore);
});

app.get('/api/highscores', async (req, res) => {
  const highScores = await HighScore.find().sort({ score: -1 }).limit(10);
  res.json(highScores);
});

app.get('/api/highscores/check/:score', async (req, res) => {
  const { score } = req.params;
  const count = await HighScore.countDocuments({ score: { $gt: score } });
  const isHighScore = count < 10;
  res.json({ isHighScore });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
