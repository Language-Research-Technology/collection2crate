// Browser implementation of ro-crate-plots' plotMapHeatmap builder.
// Its upstream Node implementation uses @napi-rs/canvas and a filesystem
// tile cache; this adapter uses browser canvas, fetch and a bounded memory cache.

const OSM = {
  name: "osm",
  tileUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  tileSize: 256,
  attribution: "Map data from OpenStreetMap",
  attributionUrl: "https://openstreetmap.org/copyright",
};
const tileCache = new Map();
const MAX_CACHED_TILES = 128;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const lonToTile = (longitude, zoom) => ((longitude + 180) / 360) * 2 ** zoom;
const latToTile = (latitude, zoom) => {
  const lat = clamp(latitude, -85.05112878, 85.05112878) * Math.PI / 180;
  return ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * 2 ** zoom;
};

function bestZoom(data, targetSizePx, tileSize) {
  const longitudes = data.map((point) => Number(point.lon));
  const latitudes = data.map((point) => Number(point.lat));
  const longitudeSpan = Math.max(...longitudes) - Math.min(...longitudes) || 0.0001;
  const latMin = clamp(Math.min(...latitudes), -85.05112878, 85.05112878) * Math.PI / 180;
  const latMax = clamp(Math.max(...latitudes), -85.05112878, 85.05112878) * Math.PI / 180;
  const projectedSpan = Math.abs(Math.log(Math.tan(Math.PI / 4 + latMax / 2)) - Math.log(Math.tan(Math.PI / 4 + latMin / 2))) || 0.0001;
  const zoomX = Math.log2((targetSizePx * 360) / (longitudeSpan * tileSize));
  const zoomY = Math.log2((targetSizePx * 2 * Math.PI) / (projectedSpan * tileSize));
  return clamp(Math.floor(Math.min(zoomX, zoomY)), 0, 20);
}

export function projectMapPoints(data, zoom, startTileX, startTileY, offsetX, offsetY, tileSize = 256) {
  return data.map((point) => ({
    x: Number(((lonToTile(Number(point.lon), zoom) - startTileX) * tileSize - offsetX).toFixed(2)),
    y: Number(((latToTile(Number(point.lat), zoom) - startTileY) * tileSize - offsetY).toFixed(2)),
    weight: Number(point.weight) || 1,
  }));
}

async function fetchTile(provider, zoom, x, y) {
  const url = provider.tileUrl.replace("{z}", zoom).replace("{x}", x).replace("{y}", y);
  if (!tileCache.has(url)) {
    const request = fetch(url, { headers: provider.headers || {} })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Map tile request failed (${response.status}).`);
        return await createImageBitmap(await response.blob());
      })
      .catch((error) => {
        tileCache.delete(url);
        console.warn(error.message);
        return null;
      });
    tileCache.set(url, request);
    if (tileCache.size > MAX_CACHED_TILES) tileCache.delete(tileCache.keys().next().value);
  }
  return tileCache.get(url);
}

async function mapImage(data, { zoom, targetSizePx, provider }) {
  const tileSize = provider.tileSize || 256;
  const minLat = Math.min(...data.map((point) => Number(point.lat)));
  const maxLat = Math.max(...data.map((point) => Number(point.lat)));
  const minLon = Math.min(...data.map((point) => Number(point.lon)));
  const maxLon = Math.max(...data.map((point) => Number(point.lon)));
  const actualZoom = zoom ?? bestZoom(data, targetSizePx, tileSize);
  const minX = lonToTile(minLon, actualZoom);
  const maxX = lonToTile(maxLon, actualZoom);
  const minY = latToTile(maxLat, actualZoom);
  const maxY = latToTile(minLat, actualZoom);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const halfSpan = targetSizePx / tileSize / 2;
  const startX = Math.floor(centerX - halfSpan);
  const endX = Math.ceil(centerX + halfSpan);
  const startY = Math.floor(centerY - halfSpan);
  const endY = Math.ceil(centerY + halfSpan);
  const offsetX = (centerX - startX) * tileSize - targetSizePx / 2;
  const offsetY = (centerY - startY) * tileSize - targetSizePx / 2;
  const canvas = document.createElement("canvas");
  canvas.width = (endX - startX + 1) * tileSize;
  canvas.height = (endY - startY + 1) * tileSize;
  const context = canvas.getContext("2d");
  context.fillStyle = "#e0e0e0";
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (let x = startX; x <= endX; x++) {
    for (let y = startY; y <= endY; y++) {
      const image = await fetchTile(provider, actualZoom, x, y);
      if (image) context.drawImage(image, (x - startX) * tileSize, (y - startY) * tileSize, tileSize, tileSize);
    }
  }
  const cropped = document.createElement("canvas");
  cropped.width = targetSizePx;
  cropped.height = targetSizePx;
  cropped.getContext("2d").drawImage(canvas, offsetX, offsetY, targetSizePx, targetSizePx, 0, 0, targetSizePx, targetSizePx);
  return {
    url: cropped.toDataURL("image/png"),
    points: projectMapPoints(data, actualZoom, startX, startY, offsetX, offsetY, tileSize),
    targetSizePx,
  };
}

export async function plotMapHeatmap({
  data = [], bandwidth = -1, nContours = 10, opacity = 0.5,
  palette = "turbo", title, subtitle, zoom, provider = OSM, targetSizePx = 300,
} = {}) {
  if (!Array.isArray(data) || data.length === 0) throw new Error("Map heatmaps need at least one data point.");
  if (data.some((point) => !Number.isFinite(Number(point.lat)) || !Number.isFinite(Number(point.lon)))) {
    throw new Error("Map heatmap rows need numeric 'lat' and 'lon' values.");
  }
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") {
    throw new Error("Map heatmaps require browser canvas and ImageBitmap support.");
  }
  const map = await mapImage(data, { zoom, targetSizePx, provider });
  const widths = Array.isArray(bandwidth) ? bandwidth : [bandwidth, bandwidth];
  const spec = {
    $schema: "https://vega.github.io/schema/vega/v6.json",
    padding: 0,
    width: map.targetSizePx,
    height: map.targetSizePx,
    title: { title, subtitle },
    autosize: { type: "fit", contains: "padding" },
    data: [
      { name: "mapPoints", values: map.points },
      { name: "density", source: "mapPoints", transform: [{
        type: "kde2d", x: "x", y: "y", weight: "weight",
        size: [map.targetSizePx, map.targetSizePx], bandwidth: widths,
      }] },
      { name: "contours", source: "density", transform: [{ type: "isocontour", field: "grid", levels: nContours }] },
    ],
    scales: [
      { name: "x", type: "linear", domain: [0, map.targetSizePx], range: [0, map.targetSizePx] },
      { name: "y", type: "linear", domain: [0, map.targetSizePx], range: [0, map.targetSizePx] },
      { name: "color", type: "linear", domain: { data: "contours", field: "contour.value" }, range: { scheme: palette } },
    ],
    marks: [
      { type: "image", encode: { enter: { url: { value: map.url }, x: { value: 0 }, y: { value: 0 }, width: { value: map.targetSizePx }, height: { value: map.targetSizePx } } } },
      { type: "path", clip: true, from: { data: "contours" }, encode: { enter: { fill: { scale: "color", field: "contour.value" }, fillOpacity: { value: opacity } } }, transform: [{ type: "geopath", field: "datum.contour" }] },
    ],
  };
  if (provider.attribution) {
    spec.marks.push({
      name: "attribTextLayer", type: "text", format: "markdown", zindex: 1,
      encode: { enter: {
        x: { signal: "width - 2" }, y: { signal: "height - 2" },
        text: { value: provider.attribution }, href: { value: provider.attributionUrl || null },
        font: { value: "sans-serif" }, fontSize: { value: 9 },
        fill: { value: provider.attributionUrl ? "mediumblue" : "#333333" },
        cursor: { value: provider.attributionUrl ? "pointer" : null },
        align: { value: "right" }, baseline: { value: "bottom" },
      } },
    });
    spec.marks.push({
      type: "rect", from: { data: "attribTextLayer" },
      encode: {
        enter: { fill: { value: "#ffffff" }, fillOpacity: { value: 0.6 } },
        update: {
          x: { field: "bounds.x1", offset: -2 }, x2: { field: "bounds.x2", offset: 2 },
          y: { field: "bounds.y1", offset: -2 }, y2: { field: "bounds.y2", offset: 2 },
        },
      },
    });
  }
  return spec;
}