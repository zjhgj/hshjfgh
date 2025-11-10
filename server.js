const express = require("express");
const fs = require("fs");
const app = express();
const PORT = process.env.PORT || 3000;

// assuming your pairing data is stored in a JSON file like 'session/creds.json'
// or if you store in DB, replace with DB call
function getPairCount() {
  try {
    let data = fs.readFileSync("./session/creds.json", "utf8");
    let parsed = JSON.parse(data);
    return parsed ? Object.keys(parsed).length : 0;
  } catch (e) {
    return 0;
  }
}

app.get("/", (req, res) => {
  res.send("Bot is running 🚀");
});

app.get("/paircount", (req, res) => {
  res.json({ pairings: getPairCount() });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
