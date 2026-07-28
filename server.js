const express = require("express");
const axios = require("axios");
const cors = require("cors");
const keywords = require("./keywords.json");
const mongoose = require("mongoose");
require("dotenv").config();

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
    origin: ["http://localhost:5173", "https://eoz-frontend.vercel.app/"],
    methods: ["GET", "POST", "PATCH"],
  }),
);
app.use(express.json());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.get("/api/advertisements", async (req, res) => {
  try {
    const results = [];

    for (let i = 0; i < keywords.length; i++) {
      const response = await axios.post(
        "https://www.eoz.kz/api/uicommand/get/page",
        {
          page: 0,
          entity: "Tender",
          length: 50,
          filter: {
            tru: null,
            name: keywords[i],
            priceFrom: "1000000",
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
