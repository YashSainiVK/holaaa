// 1. SETUP MAP
var map = L.map('map', { zoomControl: false }).setView([20.5937, 78.9629], 5);
L.control.zoom({ position: 'bottomright' }).addTo(map);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
}).addTo(map);

// 2. STATE
let markers = { start: null, end: null };
let routeLayers = [];
let userLocation = null;
let coords = { start: null, end: null };
let debounceTimer;

// 3. LOCATION
map.locate({ setView: true, maxZoom: 16, enableHighAccuracy: true });
map.on('locationfound', e => {
    userLocation = e.latlng;
    if (!coords.start) setPoint('start', e.latlng, "📍 My Location");
});
map.on('locationerror', () => showToast("⚠️ GPS failed. Search manually."));

// 4. SMART SEARCH
const inputs = { start: document.getElementById('start'), end: document.getElementById('end') };
['start', 'end'].forEach(type => {
    inputs[type].addEventListener('input', (e) => handleTyping(e.target.value, type));
});

function handleTyping(query, type) {
    clearTimeout(debounceTimer);
    const box = document.getElementById(`suggestions-${type}`);
    if (query.length < 3) return box.classList.add('hidden');

    debounceTimer = setTimeout(async () => {
        const bounds = map.getBounds();
        const viewbox = `${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()},${bounds.getSouth()}`;
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&viewbox=${viewbox}&bounded=0&limit=10&addressdetails=1`;

        try {
            const res = await fetch(url);
            let data = await res.json();
            if (data.length === 0) return box.classList.add('hidden');

            if (userLocation) {
                data.sort((a, b) => map.distance(userLocation, [a.lat, a.lon]) - map.distance(userLocation, [b.lat, b.lon]));
            }
            renderSuggestions(data, type, box);
        } catch (e) { console.error(e); }
    }, 300);
}

function renderSuggestions(data, type, box) {
    box.innerHTML = '';
    box.classList.remove('hidden');
    data.slice(0, 5).forEach(place => {
        const item = document.createElement('div');
        item.className = 'suggestion-item';
        let mainName = place.name || place.display_name.split(',')[0];
        let subText = place.display_name.replace(mainName + ',', '').trim();
        
        let distLabel = "";
        if (userLocation) {
            const km = (map.distance(userLocation, [place.lat, place.lon]) / 1000).toFixed(1);
            distLabel = `<span style="color:#2e7d32; font-weight:bold; font-size:11px; margin-left:auto;">${km} km</span>`;
        }

        item.innerHTML = `<div style="display:flex; align-items:center; width:100%;"><span style="margin-right:10px;">📍</span><div style="display:flex; flex-direction:column; overflow:hidden;"><span style="font-weight:600; font-size:13px;">${mainName}</span><span style="font-size:11px; color:#888; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${subText}</span></div>${distLabel}</div>`;
        item.onclick = () => { setPoint(type, { lat: place.lat, lng: place.lon }, mainName); box.classList.add('hidden'); };
        box.appendChild(item);
    });
}

function setPoint(type, latlng, name) {
    coords[type] = { lat: parseFloat(latlng.lat), lon: parseFloat(latlng.lng || latlng.lon) };
    inputs[type].value = name;
    if (markers[type]) map.removeLayer(markers[type]);
    markers[type] = L.marker([latlng.lat, latlng.lng || latlng.lon], { draggable: true }).addTo(map);
    markers[type].on('dragend', e => {
        coords[type] = { lat: e.target.getLatLng().lat, lon: e.target.getLatLng().lng };
        inputs[type].value = "📍 Pin Location";
        if (coords.start && coords.end) findRoute();
    });
    if (coords.start && coords.end && !routeLayers.length) {
        map.fitBounds(L.featureGroup([markers.start, markers.end]).getBounds(), { padding: [50, 50] });
    }
}

// 5. ADVANCED ROUTING ENGINE
async function findRoute() {
    if (!coords.start || !coords.end) return showToast("Select start & end points");
    document.getElementById('go-btn').innerText = "...";

    const url = `https://router.project-osrm.org/route/v1/driving/${coords.start.lon},${coords.start.lat};${coords.end.lon},${coords.end.lat}?overview=full&geometries=geojson&alternatives=true`;

    try {
        const res = await fetch(url);
        const data = await res.json();
        if (!data.routes || !data.routes.length) throw new Error("No route found");

        routeLayers.forEach(l => map.removeLayer(l));
        routeLayers = [];

        const fastRoute = data.routes[0];
        let greenRoute = data.routes[0];
        data.routes.forEach(r => { if (r.distance < greenRoute.distance) greenRoute = r; });

        if (fastRoute !== greenRoute) {
            routeLayers.push(L.geoJSON(fastRoute.geometry, { style: { color: '#90a4ae', weight: 5, opacity: 0.5, dashArray: '10, 10' } }).addTo(map));
        }
        const green = L.geoJSON(greenRoute.geometry, { style: { color: '#2e7d32', weight: 7, opacity: 0.9 } }).addTo(map);
        routeLayers.push(green);
        map.fitBounds(green.getBounds(), { padding: [50, 200] });

        calculateAdvancedStats(greenRoute, fastRoute);

    } catch (e) { showToast(e.message); } 
    finally { document.getElementById('go-btn').innerText = "Go ➔"; }
}

// 6. PHYSICS & EMISSION LOGIC
function calculateAdvancedStats(green, fast) {
    const mode = document.getElementById('transportMode').value;
    
    // Base Emissions (kg CO2 per km)
    // Source: Average emissions for modern Indian vehicles
    const factors = {
        petrol_small: 0.12, petrol_sedan: 0.15, petrol_suv: 0.20,
        diesel_sedan: 0.17, diesel_suv: 0.24,
        cng_car: 0.10, hybrid: 0.09,
        ev_sedan: 0.04, ev_suv: 0.06, electric_scooter: 0.015,
        scooter: 0.04, bike: 0.05, superbike: 0.09,
        bus_city: 0.03, bus_ac: 0.05, train: 0.02, auto: 0.07, // Per passenger
        pickup: 0.28, lorry: 0.85
    };

    let baseFactor = factors[mode] || 0.15;
    const distKm = green.distance / 1000;
    const timeHr = green.duration / 3600;
    const avgSpeed = distKm / timeHr;

    // --- PHYSICS ENGINE ---
    // 1. Traffic Penalty (Stop & Go makes engines inefficient)
    // Only applies to Combustion Engines (Not EV/Hybrid/Train)
    if (!mode.includes('ev') && !mode.includes('electric') && !mode.includes('hybrid') && !mode.includes('train')) {
        if (avgSpeed < 25) baseFactor *= 1.25; // +25% in heavy traffic
        else if (avgSpeed < 45) baseFactor *= 1.10; // +10% in moderate traffic
    }

    // 2. Drag Penalty (High speed kills efficiency for boxy cars)
    if (avgSpeed > 90) {
        if (mode.includes('suv') || mode.includes('lorry')) baseFactor *= 1.15; // +15% drag penalty
        else baseFactor *= 1.05; // +5% for aerodynamic cars
    }

    // Calculations
    const co2Green = (distKm * baseFactor).toFixed(2);
    const co2Fast = ((fast.distance / 1000) * baseFactor).toFixed(2);
    
    // Tree Logic: 1 Mature Tree absorbs ~21kg CO2 per year.
    // Let's visualize the "Savings" in terms of "Days of Tree Work"
    // Savings = (Fast - Green)
    const savedKg = Math.max(0, co2Fast - co2Green);
    // A tree absorbs ~0.06kg per day. 
    const treeDaysSaved = (savedKg / 0.06).toFixed(1);

    // Update UI
    document.getElementById('bottom-card').classList.remove('hidden');
    document.getElementById('time-display').innerText = Math.round(green.duration / 60) + " min";
    document.getElementById('distance-display').innerText = distKm.toFixed(1) + " km";
    
    document.getElementById('green-emission').innerText = co2Green + " kg";
    document.getElementById('fast-emission').innerText = co2Fast + " kg";
    
    // Show Tree Badge
    if (savedKg > 0.1) {
        document.getElementById('trees-saved').innerText = treeDaysSaved + " days of";
        document.querySelector('.tag.tree').style.display = 'inline-block';
    } else {
        document.querySelector('.tag.tree').style.display = 'none';
    }

    const banner = document.getElementById('savings-banner');
    if (savedKg > 0.05) {
        banner.innerHTML = `🌿 You saved <b>${savedKg.toFixed(2)} kg CO₂</b> vs the fastest route!`;
        banner.style.background = '#2e7d32';
    } else {
        banner.innerHTML = `✨ Fastest route is also the Greenest!`;
        banner.style.background = '#1976d2';
    }
}

function showToast(msg) {
    const t = document.getElementById('error-toast');
    t.innerText = msg;
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 3000);
}
function clearInput(type) {
    inputs[type].value = '';
    coords[type] = null;
    if(markers[type]) map.removeLayer(markers[type]);
    document.getElementById(`suggestions-${type}`).classList.add('hidden');
}
function useCurrentLocation() { map.locate({ setView: true, maxZoom: 16 }); }