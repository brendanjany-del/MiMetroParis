'use strict';

// =============================================================================
// Mi-Chemin Paris — Application Logic
// Finds the midpoint metro/RER station between two Paris addresses
// Expects STATIONS (object) and CONNECTIONS (array) from metro-data.js
// =============================================================================

// -- Line colors (official RATP) --
const LINE_COLORS = {
    '1': '#FFCD00', '2': '#003CA6', '3': '#837902', '3B': '#6EC4E8',
    '4': '#CF009E', '5': '#FF7E2E', '6': '#6ECA97', '7': '#FA9ABA',
    '7B': '#6ECA97', '8': '#E19BDF', '9': '#B6BD00', '10': '#C9910D',
    '11': '#704B1C', '12': '#007852', '13': '#6EC4E8', '14': '#62259D',
    'RER-A': '#FF1400', 'RER-B': '#4C90D1', 'RER-C': '#FFBE00',
    'RER-D': '#00814F', 'RER-E': '#BD559C'
};

// -- Graph --
let graph = {};

function buildGraph() {
    graph = {};
    for (const id of Object.keys(STATIONS)) {
        graph[id] = [];
    }
    for (const c of CONNECTIONS) {
        if (!graph[c.from] || !graph[c.to]) continue;
        graph[c.from].push({ to: c.to, time: c.time, type: c.type });
        graph[c.to].push({ to: c.from, time: c.time, type: c.type });
    }
}

// -- Dijkstra --
function dijkstra(startId) {
    const dist = {};
    const prev = {};
    const visited = new Set();
    for (const id in graph) {
        dist[id] = Infinity;
        prev[id] = null;
    }
    dist[startId] = 0;
    const pq = [{ id: startId, d: 0 }];

    while (pq.length) {
        let minIdx = 0;
        for (let i = 1; i < pq.length; i++) {
            if (pq[i].d < pq[minIdx].d) minIdx = i;
        }
        const { id: cur, d: curDist } = pq.splice(minIdx, 1)[0];
        if (visited.has(cur)) continue;
        visited.add(cur);
        if (curDist > dist[cur]) continue;
        for (const edge of (graph[cur] || [])) {
            const nd = dist[cur] + edge.time;
            if (nd < dist[edge.to]) {
                dist[edge.to] = nd;
                prev[edge.to] = cur;
                pq.push({ id: edge.to, d: nd });
            }
        }
    }
    return { dist, prev };
}

function reconstructPath(prev, from, to) {
    const path = [];
    let cur = to;
    const max = Object.keys(prev).length;
    let steps = 0;
    while (cur != null) {
        path.unshift(cur);
        if (cur === from) break;
        cur = prev[cur];
        if (++steps > max) return [];
    }
    return (path.length && path[0] === from) ? path : [];
}

// -- Haversine --
function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// -- Nearest stations --
function findNearestStations(lat, lng, count = 3) {
    const results = [];
    for (const [id, s] of Object.entries(STATIONS)) {
        const dist = haversine(lat, lng, s.lat, s.lng);
        results.push({ id, dist, walkMin: dist / 75 }); // ~4.5 km/h
    }
    results.sort((a, b) => a.dist - b.dist);
    return results.slice(0, count);
}

// -- Determine the line between two adjacent stations --
function lineBetween(fromId, toId) {
    const sA = STATIONS[fromId];
    const sB = STATIONS[toId];
    if (!sA || !sB) return null;
    // The shared line between two adjacent stations
    for (const l of sA.lines) {
        if (sB.lines.includes(l)) return l;
    }
    return null;
}

// =============================================================================
// MIDPOINT CALCULATION
// =============================================================================
function findMidpoint(addrA, addrB) {
    const nearA = findNearestStations(addrA.lat, addrA.lng, 3);
    const nearB = findNearestStations(addrB.lat, addrB.lng, 3);

    // Run Dijkstra from each candidate entry station
    const dijk = {};
    for (const s of [...nearA, ...nearB]) {
        if (!dijk[s.id]) dijk[s.id] = dijkstra(s.id);
    }

    const allIds = Object.keys(graph);
    let candidates = [];

    for (const sa of nearA) {
        const da = dijk[sa.id];
        for (const sb of nearB) {
            const db = dijk[sb.id];
            for (const mid of allIds) {
                const tA = da.dist[mid];
                const tB = db.dist[mid];
                if (tA === Infinity || tB === Infinity) continue;
                const totalA = sa.walkMin + tA;
                const totalB = sb.walkMin + tB;
                candidates.push({
                    mid, sa, sb, da, db, totalA, totalB,
                    diff: Math.abs(totalA - totalB),
                    total: totalA + totalB,
                    transitA: tA, transitB: tB
                });
            }
        }
    }

    if (!candidates.length) throw new Error('Aucun itinéraire trouvé entre ces deux adresses.');

    // Sort: minimize diff, then total time
    candidates.sort((a, b) => (a.diff - b.diff) || (a.total - b.total));

    // Pick top 2 unique meeting stations
    const seen = new Set();
    const top = [];
    for (const c of candidates) {
        if (seen.has(c.mid)) continue;
        seen.add(c.mid);
        top.push(c);
        if (top.length >= 2) break;
    }

    return top.map(c => {
        const pathA = reconstructPath(c.da.prev, c.sa.id, c.mid);
        const pathB = reconstructPath(c.db.prev, c.sb.id, c.mid);
        return {
            station: STATIONS[c.mid],
            stationId: c.mid,
            totalA: c.totalA,
            totalB: c.totalB,
            diff: c.diff,
            total: c.total,
            routeA: { walkMin: c.sa.walkMin, walkDist: c.sa.dist, entryId: c.sa.id, path: pathA },
            routeB: { walkMin: c.sb.walkMin, walkDist: c.sb.dist, entryId: c.sb.id, path: pathB }
        };
    });
}

// =============================================================================
// BUILD DISPLAY SEGMENTS
// =============================================================================
function buildSegments(route, originCoords) {
    const segs = [];
    const entry = STATIONS[route.entryId];

    // 1) Walk to entry station
    segs.push({
        type: 'walk',
        text: `Marcher jusqu'à ${entry.name}`,
        detail: `${Math.round(route.walkDist)} m — ~${Math.round(route.walkMin)} min`,
        time: Math.round(route.walkMin),
        from: originCoords,
        to: { lat: entry.lat, lng: entry.lng }
    });

    // 2) Transit segments (group consecutive stations by line)
    const path = route.path;
    if (path.length >= 2) {
        let curLine = lineBetween(path[0], path[1]);
        let group = [path[0]];

        for (let i = 1; i < path.length; i++) {
            const nextLine = (i < path.length - 1) ? lineBetween(path[i], path[i + 1]) : curLine;
            group.push(path[i]);

            if (i < path.length - 1 && nextLine !== curLine) {
                // Finish this segment
                segs.push(makeTransitSeg(curLine, group));
                curLine = nextLine;
                group = [path[i]]; // start new group with transfer station
            }
        }
        if (group.length >= 2) {
            segs.push(makeTransitSeg(curLine, group));
        }
    }

    // 3) Arrival
    const last = STATIONS[path.length ? path[path.length - 1] : route.entryId];
    segs.push({ type: 'arrival', text: `Arrivée : ${last.name}` });

    return segs;
}

function makeTransitSeg(line, ids) {
    const stations = ids.map(id => ({ id, ...STATIONS[id] }));
    const color = LINE_COLORS[line] || '#888';
    const label = (line && line.startsWith('RER')) ? line.replace('-', ' ') : `Ligne ${line || '?'}`;
    const stops = stations.length - 1;
    return {
        type: 'transit',
        line, color, stations, label,
        text: `${label} : ${stations[0].name} → ${stations[stations.length - 1].name}`,
        detail: `${stops} arrêt${stops > 1 ? 's' : ''}`,
        coords: stations.map(s => [s.lat, s.lng])
    };
}

// =============================================================================
// GEOCODING (api-adresse.data.gouv.fr)
// =============================================================================
async function geocode(query) {
    if (!query || query.trim().length < 3) return [];
    let q = query.trim();
    if (!/paris/i.test(q)) q += ' Paris';
    const url = `https://api-adresse.data.gouv.fr/search?q=${encodeURIComponent(q)}&limit=5&lat=48.8566&lon=2.3522`;
    try {
        const res = await fetch(url);
        if (!res.ok) return [];
        const data = await res.json();
        return (data.features || []).map(f => ({
            lat: f.geometry.coordinates[1],
            lng: f.geometry.coordinates[0],
            label: f.properties.label
        }));
    } catch { return []; }
}

// =============================================================================
// UI
// =============================================================================
let map = null;
let mapLayers = [];
let selectedA = null;
let selectedB = null;

function initApp() {
    buildGraph();
    console.log(`Mi-Chemin Paris : ${Object.keys(STATIONS).length} stations, ${CONNECTIONS.length} connexions`);

    // Map
    map = L.map('map').setView([48.8566, 2.3522], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19
    }).addTo(map);

    // Autocomplete
    setupAutocomplete('address-a', 'suggestions-a', v => { selectedA = v; updateBtn(); });
    setupAutocomplete('address-b', 'suggestions-b', v => { selectedB = v; updateBtn(); });

    // Search
    document.getElementById('btn-search').addEventListener('click', handleSearch);
}

function updateBtn() {
    document.getElementById('btn-search').disabled = !(selectedA && selectedB);
}

function setupAutocomplete(inputId, listId, onSelect) {
    const input = document.getElementById(inputId);
    const list = document.getElementById(listId);
    let timer = null;

    input.addEventListener('input', () => {
        onSelect(null);
        clearTimeout(timer);
        const val = input.value.trim();
        if (val.length < 3) { list.innerHTML = ''; list.classList.remove('active'); return; }
        timer = setTimeout(async () => {
            const results = await geocode(val);
            list.innerHTML = '';
            if (!results.length) { list.classList.remove('active'); return; }
            for (const r of results) {
                const li = document.createElement('li');
                li.textContent = r.label;
                li.addEventListener('click', () => {
                    input.value = r.label;
                    list.innerHTML = '';
                    list.classList.remove('active');
                    onSelect(r);
                });
                list.appendChild(li);
            }
            list.classList.add('active');
        }, 300);
    });

    // Keyboard nav
    input.addEventListener('keydown', e => {
        const items = list.querySelectorAll('li');
        if (!items.length) return;
        const sel = list.querySelector('.selected');
        let idx = sel ? Array.from(items).indexOf(sel) : -1;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (sel) sel.classList.remove('selected');
            idx = (idx + 1) % items.length;
            items[idx].classList.add('selected');
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (sel) sel.classList.remove('selected');
            idx = (idx - 1 + items.length) % items.length;
            items[idx].classList.add('selected');
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (sel) sel.click();
        } else if (e.key === 'Escape') {
            list.innerHTML = ''; list.classList.remove('active');
        }
    });

    document.addEventListener('click', e => {
        if (!e.target.closest(`#${inputId}`) && !e.target.closest(`#${listId}`)) {
            list.innerHTML = ''; list.classList.remove('active');
        }
    });
}

// -- Search handler --
async function handleSearch() {
    if (!selectedA || !selectedB) return;
    const errorEl = document.getElementById('error-message');
    const resultsPanel = document.getElementById('results-panel');
    const btn = document.getElementById('btn-search');
    const btnText = btn.querySelector('.btn-text');
    const btnLoad = btn.querySelector('.btn-loading');

    errorEl.hidden = true;
    resultsPanel.hidden = true;
    clearMapLayers();
    btn.disabled = true;
    btnText.hidden = true;
    btnLoad.hidden = false;

    try {
        const results = await new Promise((resolve, reject) => {
            setTimeout(() => {
                try { resolve(findMidpoint(selectedA, selectedB)); }
                catch (e) { reject(e); }
            }, 50);
        });

        if (!results.length) throw new Error('Aucun point de rencontre trouvé.');

        const enriched = results.map(r => ({
            ...r,
            segsA: buildSegments(r.routeA, selectedA),
            segsB: buildSegments(r.routeB, selectedB)
        }));

        renderResults(enriched);
        renderMap(enriched);
        resultsPanel.hidden = false;

    } catch (err) {
        errorEl.textContent = err.message || 'Erreur lors du calcul.';
        errorEl.hidden = false;
    } finally {
        btn.disabled = false;
        btnText.hidden = false;
        btnLoad.hidden = true;
    }
}

// =============================================================================
// RENDER RESULTS PANEL
// =============================================================================
function renderResults(results) {
    const mp = document.getElementById('meeting-points');
    mp.innerHTML = '';

    results.forEach((r, i) => {
        const card = document.createElement('div');
        card.className = 'meeting-point-card';
        const tag = i === 0 ? 'Meilleur choix' : 'Alternative';
        card.innerHTML = `
            <div style="font-size:0.75rem;font-weight:600;color:${i === 0 ? '#22C55E' : '#F59E0B'};margin-bottom:0.3rem">${tag}</div>
            <div class="station-name">${r.station.name}</div>
            <div class="lines-badges">${r.station.lines.map(l => {
                const c = LINE_COLORS[l] || '#888';
                const txt = isLight(c) ? '#000' : '#fff';
                const lbl = l.startsWith('RER') ? l.replace('-', ' ') : l;
                return `<span class="line-badge" style="background:${c};color:${txt}">${lbl}</span>`;
            }).join('')}</div>
            <div class="times">
                <span class="time-item"><span class="marker-dot marker-a"></span> ~${Math.round(r.totalA)} min</span>
                <span class="time-item"><span class="marker-dot marker-b"></span> ~${Math.round(r.totalB)} min</span>
                <span class="time-item" style="color:var(--color-text-secondary)">Écart : ${Math.round(r.diff)} min</span>
            </div>
        `;
        mp.appendChild(card);
    });

    // Itineraries for the best result
    const best = results[0];
    renderItinerary('itinerary-a', best.segsA);
    renderItinerary('itinerary-b', best.segsB);
}

function renderItinerary(panelId, segs) {
    const el = document.querySelector(`#${panelId} .itinerary-steps`);
    el.innerHTML = '';
    for (const s of segs) {
        const step = document.createElement('div');
        step.className = `step step-${s.type === 'transit' ? 'metro' : s.type}`;
        if (s.type === 'walk') {
            step.innerHTML = `
                <div class="step-icon" style="font-size:1.1rem">🚶</div>
                <div class="step-content"><div class="step-title">${s.text}</div><div class="step-detail">${s.detail}</div></div>
                <div class="step-time">${s.time} min</div>`;
        } else if (s.type === 'transit') {
            const txtC = isLight(s.color) ? '#000' : '#fff';
            const lbl = s.line && s.line.startsWith('RER') ? s.line.replace('-', ' ') : s.line;
            step.innerHTML = `
                <div class="step-icon" style="background:${s.color};color:${txtC};font-size:0.75rem;font-weight:700">${lbl}</div>
                <div class="step-content"><div class="step-title">${s.text}</div><div class="step-detail">${s.detail}</div></div>`;
        } else if (s.type === 'arrival') {
            step.innerHTML = `
                <div class="step-icon" style="background:#22C55E;color:#fff;font-size:0.9rem">★</div>
                <div class="step-content"><div class="step-title">${s.text}</div></div>`;
        }
        el.appendChild(step);
    }
}

function isLight(hex) {
    if (!hex || hex[0] !== '#') return false;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55;
}

// =============================================================================
// RENDER MAP
// =============================================================================
function clearMapLayers() {
    mapLayers.forEach(l => map.removeLayer(l));
    mapLayers = [];
}

function renderMap(results) {
    clearMapLayers();
    const bounds = L.latLngBounds([]);
    const best = results[0];

    // Address markers
    const mkA = L.marker([selectedA.lat, selectedA.lng], { icon: dot('#003CA6') })
        .addTo(map).bindPopup(`<b>Point A</b><br>${selectedA.label}`);
    const mkB = L.marker([selectedB.lat, selectedB.lng], { icon: dot('#CF009E') })
        .addTo(map).bindPopup(`<b>Point B</b><br>${selectedB.label}`);
    mapLayers.push(mkA, mkB);
    bounds.extend([selectedA.lat, selectedA.lng]);
    bounds.extend([selectedB.lat, selectedB.lng]);

    // Meeting point markers
    results.forEach((r, i) => {
        const col = i === 0 ? '#22C55E' : '#F59E0B';
        const mk = L.marker([r.station.lat, r.station.lng], { icon: meetDot(col), zIndexOffset: 1000 })
            .addTo(map).bindPopup(`<b>${i === 0 ? 'Point de rencontre' : 'Alternative'}</b><br>${r.station.name}<br>A: ~${Math.round(r.totalA)} min / B: ~${Math.round(r.totalB)} min`);
        mapLayers.push(mk);
        bounds.extend([r.station.lat, r.station.lng]);
    });

    // Routes for the best result
    drawMapRoute(best.segsA, bounds);
    drawMapRoute(best.segsB, bounds);

    map.fitBounds(bounds.pad(0.15));
}

function drawMapRoute(segs, bounds) {
    for (const s of segs) {
        if (s.type === 'walk' && s.from && s.to) {
            const line = L.polyline([[s.from.lat, s.from.lng], [s.to.lat, s.to.lng]], {
                color: '#6B7280', weight: 3, dashArray: '6,8', opacity: 0.7
            }).addTo(map);
            mapLayers.push(line);
            bounds.extend([s.to.lat, s.to.lng]);
        } else if (s.type === 'transit' && s.coords) {
            const line = L.polyline(s.coords, {
                color: s.color, weight: 5, opacity: 0.85
            }).addTo(map);
            mapLayers.push(line);
            // Station dots
            for (let i = 1; i < s.stations.length - 1; i++) {
                const st = s.stations[i];
                const c = L.circleMarker([st.lat, st.lng], {
                    radius: 3, fillColor: s.color, color: '#fff', weight: 2, fillOpacity: 1
                }).addTo(map).bindTooltip(st.name, { direction: 'top' });
                mapLayers.push(c);
            }
            s.coords.forEach(c => bounds.extend(c));
        }
    }
}

function dot(color, size = 14) {
    return L.divIcon({
        className: '',
        html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4)"></div>`,
        iconSize: [size + 6, size + 6],
        iconAnchor: [(size + 6) / 2, (size + 6) / 2]
    });
}

function meetDot(color) {
    return L.divIcon({
        className: '',
        html: `<div style="width:24px;height:24px;border-radius:50%;background:${color};border:4px solid #fff;box-shadow:0 3px 10px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px;font-weight:700">★</div>`,
        iconSize: [32, 32], iconAnchor: [16, 16], popupAnchor: [0, -18]
    });
}

// =============================================================================
// INIT
// =============================================================================
document.addEventListener('DOMContentLoaded', () => {
    if (typeof STATIONS === 'undefined' || typeof CONNECTIONS === 'undefined') {
        document.getElementById('error-message').textContent = 'Erreur : données métro non chargées.';
        document.getElementById('error-message').hidden = false;
        return;
    }
    initApp();
});
