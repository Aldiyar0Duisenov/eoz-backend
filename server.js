import express from "express";
import axios from "axios";
import cors from "cors";
import keywords from "./keywords.json" with { type: "json" };
import mongoose from "mongoose";
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import path from "path";
import fs from "fs";
import puppeteer from "puppeteer";
import { fileURLToPath } from "url";
import * as cheerio from "cheerio";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const getRandomMs = (min, max) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

// Инициализация клиентов
const ai = new GoogleGenAI({
  apiKey:
    process.env.GEMINI_API_KEY ||
    "AQ.Ab8RN6Jw4tsYfTqwSAX35BkFEShs7T6xUIiRAD7S3iebWbNBAw",
});

async function askGemini(dataset) {
  try {
    const response = await ai.interactions.create({
      model: "gemini-3.6-flash",
      input: `${dataset} из этого массива объектов создай массив id объектов у которых поле name хоть как-то может быть связано с потенциальной закупкой услуг по сервисчам 1С и связванным с ней услугами, при условии что те кто давали название были заинтересованы скрыть названия. К примеру сопровождение информационной системы считается. Верни отфильтрованный массив id. Верни тексчт который можно будет вставить в JSON.parse() без ошибки. Твой ответ должен начаться с [ и кончится ] `,
    });

    console.log(response.output_text);
    return response.output_text;
  } catch (error) {
    console.error("Ошибка запроса к Gemini:", error);
    throw error;
  }
}

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(console.error);

const advertisementSchema = new mongoose.Schema(
  {
    number: {
      type: String,
      unique: true,
      required: true,
      index: true,
    },
    status: {
      type: String,
      default: "new",
    },
  },
  {
    strict: false,
  },
);

const Advertisement = mongoose.model("Advertisement", advertisementSchema);
const app = express();

app.use(
  cors({
    origin: ["http://localhost:5173", "https://eoz-frontend.vercel.app"],
    methods: ["GET", "POST", "PATCH"],
  }),
);
app.use(express.json());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.get("/api/advertisements", async (req, res) => {
  try {
    const results = [];

    for (let i = 0; i < 5; i++) {
      const response = await axios.post(
        "https://www.eoz.kz/api/uicommand/get/page",
        {
          page: 0,
          entity: "Tender",
          length: 50,
          filter: {
            tru: null,
            name: keywords[i],
            priceFrom: process.env.COST_FILTER || "10000",
            isOOI: 0,
          },
        },
      );

      results.push(...response.data.content);

      // Каждые 10 запросов делаем паузу 5 секунд
      if ((i + 1) % 10 === 0 && i + 1 < keywords.length) {
        console.log("Пауза 5 секунд...");
        await sleep(5000);
      }
    }
    const seen = new Set();

    const uniqueResults = results.filter((item) => {
      if (seen.has(item.number)) {
        return false;
      }

      seen.add(item.number);
      return true;
    });

    await Advertisement.bulkWrite(
      uniqueResults.map((item) => ({
        updateOne: {
          filter: { number: item.number },
          update: { $set: item },
          upsert: true,
        },
      })),
    );

    res.json({
      content: uniqueResults,
    });

    /*res.json({
      content: uniqueResults,
    });*/
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Ошибка получения данных",
    });
  }
});

app.get("/api/advertisements_refresh", async (req, res) => {
  try {
    const { statuses } = req.query;

    const filter = {};

    if (statuses) {
      const statusArray = statuses.split(",").map((status) => status.trim());
      filter.status = { $in: statusArray };
    }

    const advertisements = await Advertisement.find(filter).lean();

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const filteredAdvertisements = advertisements.filter((ad) => {
      const [day, month, year] = ad.endDate.split(".");

      const endDate = new Date(Number(year), Number(month) - 1, Number(day));

      // Показываем только если дата окончания сегодня или позже
      return endDate >= today;
    });

    res.json({
      content: filteredAdvertisements,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Ошибка чтения БД",
    });
  }
});

app.patch("/api/advertisements/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const allowedStatuses = ["new", "reject", "consideration"];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        error: "Некорректный статус",
      });
    }

    const advertisement = await Advertisement.findByIdAndUpdate(
      id,
      { status },
      { new: true },
    );

    if (!advertisement) {
      return res.status(404).json({
        error: "Объявление не найдено",
      });
    }

    res.json({
      content: advertisement,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Ошибка обновления статуса",
    });
  }
});

app.get("/api/ai_filter", async (req, res) => {
  try {
    const advertisements = await Advertisement.find({ status: "new" }).lean();
    console.log(advertisements.length);
    const dataset = advertisements.map((c) => ({
      id: c.id,
      name: c.nameru,
      sum: c.sum,
    }));
    const aiFiltered = await askGemini(JSON.stringify(dataset));
    const filteredAdvertisements = JSON.parse(aiFiltered);

    const datasetId = dataset.map((d) => d.id);

    const updateResult = await Advertisement.updateMany(
      {
        id: {
          $in: datasetId,
          $nin: filteredAdvertisements,
        },
      },
      {
        $set: { status: "reject" },
      },
    );
    res.json({});
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Ошибка чтения БД",
    });
  }
});

app.get("/scrape", async (req, res) => {
  let browser;
  try {
    const downloadPath = path.resolve(__dirname, "downloads");
    if (!fs.existsSync(downloadPath)) {
      fs.mkdirSync(downloadPath, { recursive: true });
    }

    browser = await puppeteer.launch({
      //executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
        "--start-maximized",
      ],
      //headless: false,
    });

    const page = await browser.newPage();

    // Настраиваем CDP для скачивания на уровне браузера/вкладки
    const client = await page.target().createCDPSession();
    await client.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadPath,
    });

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    );

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    await page.setViewport({ width: 1680, height: 720 });

    const parsedData = [];
    async function parseTable(keyword, pageIndex) {
      const lotStatus = "DISCUSSION_PUBLISHED";
      await page.goto(
        `https://zakup.sk.kz/#/ext?tabs=advert&q=${keyword}&adst=${lotStatus}&lst=ALL&page=${pageIndex}`,
        { waitUntil: "domcontentloaded", timeout: 60000 },
      );

      console.log("Ждем отрисовки Angular контейнера...");
      await page.waitForSelector("#infinityScroll", { timeout: 45000 });
      await delay(getRandomMs(2000, 4000));

      const html = await page.content();
      const value = cheerio.load(html);
      const items = value("#infinityScroll .m-found-item").get();

      for (const el of items) {
        const name = value(".m-found-item__title", el).text().trim();
        const rawNum = value(".m-found-item__num", el).text().trim();
        const rawPrice = value(".m-found-item__col--sum .m-span--dark", el)
          .text()
          .trim();

        const sum = Number(rawPrice.replace(/\D/g, "")) || 0;
        const number = Number(rawNum.replace(/\D/g, "")) || 0;

        console.log(`Обрабатываем закупку №${number}...`);

        if (number && !parsedData.find((data) => data.number === number)) {
          // Передаем существую страницу в функцию скачивания

          parsedData.push({ number, name, sum });
        }

        //await delay(getRandomMs(2000, 4000));
      }
      const xpathSelector = `xpath///ngb-pagination//ul[contains(@class, "pagination")]//a[normalize-space(text())="${pageIndex + 1}"]`;

      // !! превратит (ElementHandle | null) в (true | false)
      const hasNext = !!(await page.$(xpathSelector));
      console.log(hasNext);
      if (hasNext && pageIndex < 4) {
        await parseTable(keyword, pageIndex + 1); // Рекурсивно вызываем для следующей страницы
      }
    }

    for (const keyword of keywords) {
      await parseTable(keyword, 1);
    }
    //await parseTable("сопровождению", 1);

    await Advertisement.bulkWrite(
      parsedData.map((item) => ({
        updateOne: {
          filter: { number: item.number },
          update: {
            $set: {
              id: `${item.number}-${item.number}`,
              number: item.number,
              nameru: item.name,
              namekz: item.name,
              sum: item.sum,
              systemNameRu: "СКК",
              systemNameKz: "СКК",
              statusNameRu: "Предварительное обсуждение",
              statusNameKz: "Предварительное обсуждение",
              dayCount: 7,
              startDate: `${new Date().toLocaleDateString("ru-RU")}`,
              endDate: `${new Date(new Date().getTime() + 1000 * 60 * 60 * 24 * 7).toLocaleDateString("ru-Ru")}`,
              userFavourites: [],
              customerBin: null,
              subjectNameRu: null,
              subjectNameKz: null,
              externalId: 0,
            },
          },
          upsert: true,
        },
      })),
    );

    res.json({ success: true, count: parsedData.length, result: parsedData });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
