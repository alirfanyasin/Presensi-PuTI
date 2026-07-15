const fs = require("fs");
const path = require("path");
const https = require("https");

const cacheDir = path.join(__dirname, "cache");
if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}

// In-memory cache to prevent slow disk reads on every route navigation
const memoryCache = {};
const memoryCacheDate = {};

function fetchHolidaysFromAPI(year) {
  return new Promise((resolve, reject) => {
    const url = `https://libur.deno.dev/api?year=${year}`;
    https
      .get(url, (res) => {
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
      })
      .on("error", (err) => {
        reject(err);
      });
  });
}

async function loadHolidays(year) {
  const todayDate = new Date().toDateString();

  if (memoryCache[year] && memoryCacheDate[year] === todayDate) {
    return memoryCache[year];
  }

  const cachePath = path.join(cacheDir, `holidays_${year}.json`);

  // Check if cache exists and was modified today
  if (fs.existsSync(cachePath)) {
    try {
      const stats = fs.statSync(cachePath);
      const fileDate = new Date(stats.mtime).toDateString();

      if (fileDate !== todayDate) {
        console.log(`Holiday cache for year ${year} is outdated. Deleting and re-fetching...`);
        try {
          fs.unlinkSync(cachePath);
        } catch (unlinkErr) {
          console.warn("Failed to delete outdated holiday cache file:", unlinkErr.message);
        }
      } else {
        const data = fs.readFileSync(cachePath, "utf8");
        const parsed = JSON.parse(data);
        memoryCache[year] = parsed;
        memoryCacheDate[year] = todayDate;
        return parsed;
      }
    } catch (e) {
      console.error("Failed to read or validate holiday cache:", e);
    }
  }

  // Fetch from API
  try {
    const holidays = await fetchHolidaysFromAPI(year);
    if (Array.isArray(holidays)) {
      fs.writeFileSync(cachePath, JSON.stringify(holidays, null, 2), "utf8");
      memoryCache[year] = holidays;
      memoryCacheDate[year] = todayDate;
      return holidays;
    }
  } catch (e) {
    console.warn(
      `Failed to fetch holidays for year ${year} from API. Using empty list. Error:`,
      e.message,
    );
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
    const found = holidays.find((h) => h.date === dateStr);
    if (found) {
      return { isHoliday: true, name: found.name };
    }
  }

  return { isHoliday: false, name: null };
}

module.exports = {
  isHoliday,
  loadHolidays,
};
