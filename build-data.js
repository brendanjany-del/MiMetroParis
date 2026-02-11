// Build metro-data.js from the JSON source files
// Fixes station ordering by sorting geographically along each line
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
const metroStations = JSON.parse(fs.readFileSync(path.join(dataDir, 'metro-stations.json'), 'utf8'));
const rerStations = JSON.parse(fs.readFileSync(path.join(dataDir, 'rer-stations.json'), 'utf8'));
const metroRoutes = JSON.parse(fs.readFileSync(path.join(dataDir, 'metro-routes.json'), 'utf8'));
const rerRoutes = JSON.parse(fs.readFileSync(path.join(dataDir, 'rer-routes.json'), 'utf8'));

// ---- Helpers ----
function slugify(name) {
    return name
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/['']/g, '-')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---- 1. Build node lookup by ID ----
const nodeById = {};
for (const el of [...metroStations.elements, ...rerStations.elements]) {
    if (el.type === 'node') nodeById[el.id] = el;
}

// ---- 2. Build unified STATIONS ----
const stationsBySlug = {};

function addStation(node, lineRef, isRER) {
    const name = node.tags.name || node.tags['name:fr'];
    if (!name) return;
    const slug = slugify(name);
    const lineLabel = isRER ? `RER-${lineRef}` : lineRef;
    if (!stationsBySlug[slug]) {
        stationsBySlug[slug] = { name, lat: node.lat, lng: node.lon, lines: [] };
    }
    if (!stationsBySlug[slug].lines.includes(lineLabel)) {
        stationsBySlug[slug].lines.push(lineLabel);
    }
}

for (const el of metroStations.elements) {
    if (el.type === 'node' && el.tags) {
        addStation(el, el.tags.line || el.tags['ref:FR:RATP'], false);
    }
}
for (const el of rerStations.elements) {
    if (el.type === 'node' && el.tags) {
        for (const l of (el.tags.line || '').split(';')) {
            if (l.trim()) addStation(el, l.trim(), true);
        }
    }
}

// ---- 3. Order stations on each line geographically ----
// Use nearest-neighbor chain starting from the endpoint with smallest ID
function orderStationsOnLine(nodeRefs) {
    const nodes = nodeRefs.map(ref => nodeById[ref]).filter(Boolean);
    if (nodes.length <= 2) return nodes;

    // Find the two nodes that are farthest apart (endpoints)
    let maxDist = 0, endA = 0, endB = 1;
    for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
            const d = haversine(nodes[i].lat, nodes[i].lon, nodes[j].lat, nodes[j].lon);
            if (d > maxDist) { maxDist = d; endA = i; endB = j; }
        }
    }

    // Nearest-neighbor chain from endA
    const ordered = [nodes[endA]];
    const remaining = new Set(nodes.map((_, i) => i));
    remaining.delete(endA);

    while (remaining.size > 0) {
        const last = ordered[ordered.length - 1];
        let nearest = -1, nearestDist = Infinity;
        for (const idx of remaining) {
            const d = haversine(last.lat, last.lon, nodes[idx].lat, nodes[idx].lon);
            if (d < nearestDist) { nearestDist = d; nearest = idx; }
        }
        ordered.push(nodes[nearest]);
        remaining.delete(nearest);
    }

    return ordered;
}

// ---- 4. Build CONNECTIONS from ordered routes ----
const connections = [];
const connectionSet = new Set();

function addConnection(fromSlug, toSlug, time, type) {
    const key = [fromSlug, toSlug].sort().join('|');
    if (connectionSet.has(key)) return;
    if (fromSlug === toSlug) return;
    if (!stationsBySlug[fromSlug] || !stationsBySlug[toSlug]) return;
    connectionSet.add(key);
    connections.push({ from: fromSlug, to: toSlug, time, type });
}

// Process metro routes
for (const rel of metroRoutes.elements) {
    if (rel.type !== 'relation') continue;
    const stopRefs = rel.members.filter(m => m.role === 'stop').map(m => m.ref);
    const ordered = orderStationsOnLine(stopRefs);

    for (let i = 0; i < ordered.length - 1; i++) {
        const a = ordered[i], b = ordered[i + 1];
        const nameA = a.tags.name || a.tags['name:fr'];
        const nameB = b.tags.name || b.tags['name:fr'];
        if (!nameA || !nameB) continue;

        const dist = haversine(a.lat, a.lon, b.lat, b.lon);
        // Metro avg speed ~30 km/h + 20s stop = dist/(500m/min) + 0.33
        const time = Math.max(1, Math.round((dist / 500 + 0.33) * 10) / 10);
        addConnection(slugify(nameA), slugify(nameB), time, 'metro');
    }
}

// Process RER routes
for (const rel of rerRoutes.elements) {
    if (rel.type !== 'relation') continue;
    const stopRefs = rel.members.filter(m => m.role === 'stop').map(m => m.ref);
    const ordered = orderStationsOnLine(stopRefs);

    for (let i = 0; i < ordered.length - 1; i++) {
        const a = ordered[i], b = ordered[i + 1];
        const nameA = a.tags.name || a.tags['name:fr'];
        const nameB = b.tags.name || b.tags['name:fr'];
        if (!nameA || !nameB) continue;

        const dist = haversine(a.lat, a.lon, b.lat, b.lon);
        // RER avg speed ~50 km/h + 30s stop = dist/(833m/min) + 0.5
        const time = Math.max(1.5, Math.round((dist / 833 + 0.5) * 10) / 10);
        addConnection(slugify(nameA), slugify(nameB), time, 'rer');
    }
}

// ---- 5. Add transfer connections between different-name stations ----
const TRANSFERS = [
    ['chatelet', 'chatelet-les-halles', 4],
    ['saint-michel', 'saint-michel-notre-dame', 3],
    ['cluny-la-sorbonne', 'saint-michel-notre-dame', 4],
    ['montparnasse-bienvenue', 'gare-montparnasse', 4],
    ['gare-de-l-est', 'gare-du-nord', 5],
    ['magenta', 'gare-du-nord', 3],
    ['magenta', 'gare-de-l-est', 4],
    ['haussmann-saint-lazare', 'saint-lazare', 3],
    ['musee-d-orsay', 'solferino', 3],
    ['la-defense-grande-arche', 'la-defense', 3],
];

for (const [from, to, time] of TRANSFERS) {
    if (stationsBySlug[from] && stationsBySlug[to]) {
        addConnection(from, to, time, 'transfer');
    }
}

// ---- 6. Output ----
let output = '// Auto-generated from RATP/IDFM open data\n';
output += '// Metro lines: 1-14, 3bis, 7bis | RER: A, B, C, D, E\n';
output += `// ${Object.keys(stationsBySlug).length} stations, ${connections.length} connections\n\n`;

output += 'const STATIONS = {\n';
for (const slug of Object.keys(stationsBySlug).sort()) {
    const s = stationsBySlug[slug];
    output += `  "${slug}": { name: ${JSON.stringify(s.name)}, lat: ${s.lat}, lng: ${s.lng}, lines: ${JSON.stringify(s.lines)} },\n`;
}
output += '};\n\n';

output += 'const CONNECTIONS = [\n';
for (const c of connections) {
    output += `  { from: "${c.from}", to: "${c.to}", time: ${c.time}, type: "${c.type}" },\n`;
}
output += '];\n';

fs.writeFileSync(path.join(__dirname, 'js', 'metro-data.js'), output, 'utf8');

console.log(`Generated metro-data.js:`);
console.log(`  Stations: ${Object.keys(stationsBySlug).length}`);
console.log(`  Connections: ${connections.length}`);
