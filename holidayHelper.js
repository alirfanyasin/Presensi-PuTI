const fs = require("fs");
const path = require("path");
const https = require("https");

const cacheDir = path.join(__dirname, "cache");
if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}

function fetchHolidaysFromAPI(year) {
  return new Promise((resolve, reject) => {
    const url = `https://libur.deno.dev/api?year=${year}`;
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", (err) => {
      reject(err);
    });
  });
}

async function loadHolidays(year) {
  const cachePath = path.join(cacheDir, `holidays_${year}.json`);
  
  // Check if cache exists
  if (fs.existsSync(cachePath)) {
    try {
      const data = fs.readFileSync(cachePath, "utf8");
      return JSON.parse(data);
    } catch (e) {
      console.error("Failed to read holiday cache:", e);
    }
  }

  // Fetch from API
  try {
    const holidays = await fetchHolidaysFromAPI(year);
    if (Array.isArray(holidays)) {
      fs.writeFileSync(cachePath, JSON.stringify(holidays, null, 2), "utf8");
      return holidays;
    }
  } catch (e) {
    console.warn(`Failed to fetch holidays for year ${year} from API. Using empty list. Error:`, e.message);
  }

  return [];
}

async function isHoliday(dateStr) {
  if (!dateStr) return false;
  
  // 1. Check weekend (Saturday or Sunday)
  const d = new Date(dateStr);
  const day = d.getDay(); // 0 = Sunday, 6 = Saturday
  if (day === 0 || day === 6) {
    return { isHoliday: true, name: "Akhir Pekan" };
  }

  // 2. Check public holidays from API cache
  const year = dateStr.substring(0, 4);
  const holidays = await loadHolidays(year);
  if (Array.isArray(holidays)) {
    const found = holidays.find(h => h.date === dateStr);
    if (found) {
      return { isHoliday: true, name: found.name };
    }
  }

  return { isHoliday: false, name: null };
}

module.exports = {
  isHoliday,
  loadHolidays
};
