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
const TICKETMASTER_KEY = process.env.TICKETMASTER_KEY;
const OPENAGENDA_KEY = process.env.OPENAGENDA_KEY;

/* ---------------------------------------------------------
   Identifiants des agendas officiels OpenAgenda par ville
   (trouvés via /v2/agendas?search={ville}&official=1)
--------------------------------------------------------- */
const OPENAGENDA_IDS = {
  rennes: 85319813, // "Rennes Métropole"
};

/* ---------------------------------------------------------
   Coordonnées des villes, pour chercher les événements dans
   un rayon autour de chacune.
--------------------------------------------------------- */
const CITY_COORDS = {
  paris: { lat: 48.8566, lon: 2.3522 },
  lyon: { lat: 45.764, lon: 4.8357 },
  marseille: { lat: 43.2965, lon: 5.3698 },
  toulouse: { lat: 43.6047, lon: 1.4442 },
  rennes: { lat: 48.1173, lon: -1.6778 },
  nice: { lat: 43.7102, lon: 7.262 },
  cannes: { lat: 43.5528, lon: 7.0174 },
  antibes: { lat: 43.5804, lon: 7.1251 },
  monaco: { lat: 43.7384, lon: 7.4246 },
  nantes: { lat: 47.2184, lon: -1.5536 },
  strasbourg: { lat: 48.5734, lon: 7.7521 },
  bordeaux: { lat: 44.8378, lon: -0.5792 },
  lille: { lat: 50.6292, lon: 3.0573 },
  montpellier: { lat: 43.6108, lon: 3.8767 },
  grenoble: { lat: 45.1885, lon: 5.7245 },
  toulon: { lat: 43.1242, lon: 5.928 },
  reims: { lat: 49.2583, lon: 4.0317 },
  "saint-etienne": { lat: 45.4397, lon: 4.3872 },
};

/* ---------------------------------------------------------
   Codes IATA des aéroports couverts (pas besoin de les
   redemander à chaque appel, ils ne changent jamais).
   Les villes sans grand aéroport n'ont volontairement pas
   d'entrée ici — l'appli gère ce cas proprement.
--------------------------------------------------------- */
const AIRPORT_CODES = {
  paris: "CDG",
  lyon: "LYS",
  marseille: "MRS",
  toulouse: "TLS",
  rennes: "RNS",
  nice: "NCE",
  nantes: "NTE",
  strasbourg: "SXB",
  bordeaux: "BOD",
  lille: "LIL",
  montpellier: "MPL",
  grenoble: "GNB",
  toulon: "TLN",
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

async function getVehicleJourneyOrigin(vehicleJourneyId) {
  // Le champ "direction" ne donne que la destination finale de la ligne,
  // ce qui est inutile (voire faux) pour afficher la provenance d'un train
  // à l'arrivée. On va donc chercher le tout premier arrêt de son trajet.
  try {
    const data = await sncfFetch(`/vehicle_journeys/${encodeURIComponent(vehicleJourneyId)}`);
    const vj = data.vehicle_journeys && data.vehicle_journeys[0];
    const firstStop = vj?.stop_times?.[0]?.stop_point?.name;
    return firstStop || null;
  } catch {
    return null;
  }
}

async function getTrainSchedule(stationName, kind) {
  // kind = "departures" | "arrivals"
  const stopAreaId = await resolveStopArea(stationName);
  const datetime = navitiaDatetimeNow();
  const data = await sncfFetch(
    `/stop_areas/${encodeURIComponent(stopAreaId)}/${kind}?datetime=${datetime}&count=15`
  );
  const items = data[kind] || [];

  return Promise.all(
    items.map(async (item) => {
      const info = item.display_informations || {};
      const dt =
        kind === "departures"
          ? item.stop_date_time?.departure_date_time
          : item.stop_date_time?.arrival_date_time;
      const mode = info.commercial_mode || "Train";

      if (kind === "departures") {
        const destination = info.direction;
        const label = isPlaceLike(destination)
          ? `${mode} à destination de ${destination}`
          : `${mode} n°${info.headsign || "?"}`;
        return { time: formatTimeFromNavitia(dt), label };
      }

      // Arrivées : on va chercher le vrai premier arrêt du trajet.
      const vjId = item.links?.find((l) => l.type === "vehicle_journey")?.id;
      const origin = vjId ? await getVehicleJourneyOrigin(vjId) : null;
      const label = isPlaceLike(origin)
        ? `${mode} en provenance de ${origin}`
        : `${mode} n°${info.headsign || "?"}`;
      return { time: formatTimeFromNavitia(dt), label };
    })
  );
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
   Événements — concerts/festivals (OpenAgenda ou Ticketmaster)
--------------------------------------------------------- */
async function getOpenAgendaEvents(agendaUid) {
  const now = new Date();
  const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const url =
    `https://api.openagenda.com/v2/agendas/${agendaUid}/events` +
    `?key=${OPENAGENDA_KEY}` +
    `&timings[gte]=${encodeURIComponent(now.toISOString())}` +
    `&timings[lte]=${encodeURIComponent(in30Days.toISOString())}` +
    `&sort=timings.asc` +
    `&size=20`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`OpenAgenda a répondu ${res.status}`);
  const data = await res.json();
  const items = data.events || [];

  return items.map((ev) => {
    const title = ev.title?.fr || Object.values(ev.title || {})[0] || "Événement";
    const begin = ev.firstTiming?.begin || ev.nextTiming?.begin;
    const date = begin ? begin.slice(0, 10) : null;
    const time = begin ? begin.slice(11, 16) : null;
    return {
      name: title,
      date,
      time,
      venue: ev.location?.name || "Lieu non précisé",
      category: "Événement",
      url: ev.onlineAccessLink || null,
    };
  });
}

async function getTicketmasterEvents(cityKey) {
  const coords = CITY_COORDS[cityKey];
  if (!coords) throw new Error(`Ville non couverte : ${cityKey}`);

  const now = new Date();
  const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const url =
    `https://app.ticketmaster.com/discovery/v2/events.json` +
    `?apikey=${TICKETMASTER_KEY}` +
    `&latlong=${coords.lat},${coords.lon}` +
    `&radius=40&unit=km` +
    `&startDateTime=${now.toISOString().split(".")[0]}Z` +
    `&endDateTime=${in30Days.toISOString().split(".")[0]}Z` +
    `&sort=date,asc` +
    `&size=20`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Ticketmaster a répondu ${res.status}`);
  const data = await res.json();
  const items = data._embedded?.events || [];

  return items.map((ev) => {
    const venue = ev._embedded?.venues?.[0];
    const segment = ev.classifications?.[0]?.segment?.name;
    const localDate = ev.dates?.start?.localDate;
    const localTime = ev.dates?.start?.localTime;
    return {
      name: ev.name,
      date: localDate || null,
      time: localTime ? localTime.slice(0, 5) : null,
      venue: venue?.name || "Lieu non précisé",
      category: segment || "Événement",
      url: ev.url || null,
    };
  });
}

async function getEvents(cityKey) {
  // Concerts / festivals / expos : agenda officiel OpenAgenda si on le
  // connaît, sinon repli sur Ticketmaster.
  try {
    const agendaUid = OPENAGENDA_IDS[cityKey];
    return agendaUid ? await getOpenAgendaEvents(agendaUid) : await getTicketmasterEvents(cityKey);
  } catch (err) {
    return [];
  }
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

// GET /api/events?city=rennes
app.get("/api/events", async (req, res) => {
  const { city } = req.query;
  if (!city) {
    return res.status(400).json({ error: "Paramètre attendu : city" });
  }
  try {
    const result = await getEvents(city);
    res.json({ city, result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Cadence server en écoute sur le port ${PORT}`);
});
