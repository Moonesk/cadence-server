// Serveur relais Cadence
// -----------------------------------------------------------------------
// Ce serveur reçoit les demandes de l'appli (trains / vols, arrivées /
// départs) et interroge à sa place l'API SNCF (Navitia) et AviationStack,
// en utilisant les clés stockées en variables d'environnement — jamais
// exposées au navigateur de l'utilisateur final.
//
// Démarrage local :
//   1. npm install
//   2. Copier .env.example en .env et renseigner vos clés
//   3. node server.js
// -----------------------------------------------------------------------

import express from "express";
import cors from "cors";
import "dotenv/config";

const app = express();
app.use(cors()); // à restreindre à votre domaine d'appli une fois en prod

const PORT = process.env.PORT || 3000;
const SNCF_TOKEN = process.env.SNCF_TOKEN;
const AVIATIONSTACK_KEY = process.env.AVIATIONSTACK_KEY;

/* ---------------------------------------------------------
   Codes IATA des aéroports couverts (pas besoin de les
   redemander à chaque appel, ils ne changent jamais).
--------------------------------------------------------- */
const AIRPORT_CODES = {
  paris: "CDG",
  lyon: "LYS",
  marseille: "MRS",
  toulouse: "TLS",
  rennes: "RNS",
};

/* ---------------------------------------------------------
   Utilitaires
--------------------------------------------------------- */
function formatTimeFromNavitia(dateTimeStr) {
  // Format Navitia : "20260908T193000" -> "19:30"
  if (!dateTimeStr || dateTimeStr.length < 13) return "--:--";
  return `${dateTimeStr.slice(9, 11)}:${dateTimeStr.slice(11, 13)}`;
}

function formatTimeFromISO(isoStr) {
  if (!isoStr) return "--:--";
  const d = new Date(isoStr);
  if (isNaN(d)) return "--:--";
  return d.toISOString().slice(11, 16);
}

function navitiaDatetimeNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/* ---------------------------------------------------------
   SNCF (Navitia) — résout un nom de gare en identifiant,
   puis récupère les prochains passages (arrivées/départs).
--------------------------------------------------------- */
async function sncfFetch(path) {
  const auth = Buffer.from(`${SNCF_TOKEN}:`).toString("base64");
  const res = await fetch(`https://api.sncf.com/v1/coverage/sncf${path}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`SNCF API a répondu ${res.status}`);
  return res.json();
}

async function resolveStopArea(stationName) {
  const data = await sncfFetch(
    `/places?q=${encodeURIComponent(stationName)}&type[]=stop_area&count=1`
  );
  const place = data.places && data.places[0];
  if (!place) throw new Error(`Gare introuvable : ${stationName}`);
  return place.id; // ex. stop_area:SNCF:87471003
}

function isPlaceLike(str) {
  // Vraie détection d'un nom de lieu (contient des lettres),
  // par opposition à un simple numéro de mission/train.
  return typeof str === "string" && /[A-Za-zÀ-ÿ]/.test(str);
}

async function getTrainSchedule(stationName, kind) {
  // kind = "departures" | "arrivals"
  const stopAreaId = await resolveStopArea(stationName);
  const datetime = navitiaDatetimeNow();
  const data = await sncfFetch(
    `/stop_areas/${encodeURIComponent(stopAreaId)}/${kind}?datetime=${datetime}&count=15`
  );
  const items = data[kind] || [];
  return items.map((item) => {
    const info = item.display_informations || {};
    const dt =
      kind === "departures"
        ? item.stop_date_time?.departure_date_time
        : item.stop_date_time?.arrival_date_time;
    const mode = info.commercial_mode || "Train";
    // "direction" contient en général un vrai nom de lieu ; "headsign" est
    // parfois juste un numéro de mission (fréquent sur certains TER).
    const place = info.direction || info.headsign;
    const label = isPlaceLike(place)
      ? `${mode} ${kind === "departures" ? "à destination de" : "en provenance de"} ${place}`
      : `${mode} n°${info.headsign || "?"}`;
    return { time: formatTimeFromNavitia(dt), label };
  });
}

/* ---------------------------------------------------------
   AviationStack — arrivées / départs vols par aéroport
--------------------------------------------------------- */
async function getFlightSchedule(cityKey, kind) {
  const iata = AIRPORT_CODES[cityKey];
  if (!iata) throw new Error(`Ville non couverte : ${cityKey}`);
  const param = kind === "departures" ? "dep_iata" : "arr_iata";
  const res = await fetch(
    `https://api.aviationstack.com/v1/flights?access_key=${AVIATIONSTACK_KEY}&${param}=${iata}&limit=15`
  );
  if (!res.ok) throw new Error(`AviationStack a répondu ${res.status}`);
  const data = await res.json();
  const items = data.data || [];
  return items.map((f) => {
    const leg = kind === "departures" ? f.departure : f.arrival;
    const otherAirport = kind === "departures" ? f.arrival?.airport : f.departure?.airport;
    return {
      time: formatTimeFromISO(leg?.scheduled),
      label: `Vol ${f.airline?.name || ""} ${
        kind === "departures" ? "à destination de" : "en provenance de"
      } ${otherAirport || "?"}`.trim(),
      status: f.flight_status,
    };
  });
}

/* ---------------------------------------------------------
   Routes
--------------------------------------------------------- */
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "cadence-server" });
});

// GET /api/trains?station=Rennes&kind=arrivals|departures
app.get("/api/trains", async (req, res) => {
  const { station, kind } = req.query;
  if (!station || !["arrivals", "departures"].includes(kind)) {
    return res.status(400).json({ error: "Paramètres attendus : station, kind=arrivals|departures" });
  }
  try {
    const result = await getTrainSchedule(station, kind);
    res.json({ station, kind, result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/flights?city=rennes&kind=arrivals|departures
app.get("/api/flights", async (req, res) => {
  const { city, kind } = req.query;
  if (!city || !["arrivals", "departures"].includes(kind)) {
    return res.status(400).json({ error: "Paramètres attendus : city, kind=arrivals|departures" });
  }
  try {
    const result = await getFlightSchedule(city, kind);
    res.json({ city, kind, result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Cadence server en écoute sur le port ${PORT}`);
});
