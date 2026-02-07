let map;
let markers = [];
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
let turnstileToken = null;
let state = {
  lat: null,
  lng: null,
  results: []
};

function setStatus(type, message) {
  const el = document.getElementById("status");
  if (!message) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.classList.remove("hidden");
  el.className = "mt-4 text-sm";
  if (type === "loading") el.classList.add("text-blue-600");
  if (type === "error") el.classList.add("text-red-600");
  if (type === "info") el.classList.add("text-slate-600");
  el.textContent = message;
}

function updateCoordsLabel() {
  const el = document.getElementById("coords");
  if (state.lat && state.lng) {
    el.textContent = `${state.lat.toFixed(6)}, ${state.lng.toFixed(6)}`;
  } else {
    el.textContent = "未取得";
  }
}

function updateParsedView(parsed) {
  document.getElementById("parsedQuery").textContent = parsed.query || "-";
  document.getElementById("parsedRadius").textContent = `${parsed.radius_m || "-"} m`;
  document.getElementById("parsedMode").textContent = parsed.weight_mode || "-";
}

function updateCharCount() {
  const input = document.getElementById("nlInput");
  document.getElementById("charCount").textContent = `${input.value.length} 字`;
}

function setResultCount(count) {
  document.getElementById("resultCount").textContent = `${count} items`;
}

function clearMarkers() {
  markers.forEach(m => m.setMap(null));
  markers = [];
}

function renderResults() {
  const container = document.getElementById("results");
  container.innerHTML = "";
  clearMarkers();

  state.results.forEach((item, idx) => {
    const card = document.createElement("div");
    card.className = "bg-slate-950/70 rounded-xl border border-slate-800 p-3 shadow-sm hover:shadow-md transition";
    card.dataset.id = item.id;
    const label = item.flag_label
      ? `<span class="ml-2 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">${item.flag_label}</span>`
      : "";
    card.innerHTML = `
      <div class="flex items-center justify-between">
        <div class="font-semibold">${item.name}${label}</div>
        <div class="text-xs text-slate-400">#${idx + 1}</div>
      </div>
      <div class="mt-1 text-sm text-slate-300">距離: ${Math.round(item.distance_m)}m</div>
      <div class="text-sm text-slate-300">評分: ${item.rating} (${item.rating_count})</div>
      <div class="text-sm text-slate-300">hot_score: ${item.hot_score.toFixed(2)}</div>
      <div class="mt-1 text-sm text-emerald-200 font-semibold">score: ${item.score.toFixed(3)}</div>
    `;
    card.addEventListener("click", () => {
      map.panTo({ lat: item.lat, lng: item.lng });
      highlightCard(item.id);
    });
    container.appendChild(card);

    const marker = new google.maps.Marker({
      position: { lat: item.lat, lng: item.lng },
      map,
      label: `${idx + 1}`
    });
    marker.addListener("click", () => {
      map.panTo({ lat: item.lat, lng: item.lng });
      highlightCard(item.id);
    });
    markers.push(marker);
  });
}

function highlightCard(id) {
  document.querySelectorAll("#results > div").forEach(el => {
    if (el.dataset.id === id) {
      el.classList.add("ring-2", "ring-emerald-400");
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const item = state.results.find(x => x.id === id);
      if (item) {
        document.getElementById("debugWd").textContent = item.score_breakdown.Wd;
        document.getElementById("debugWr").textContent = item.score_breakdown.Wr;
        document.getElementById("debugBreakdown").textContent = JSON.stringify(item.score_breakdown, null, 2);
      }
    } else {
      el.classList.remove("ring-2", "ring-emerald-400");
    }
  });
}

async function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("瀏覽器不支援定位"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve(pos.coords),
      err => reject(err)
    );
  });
}

async function interpretText(text) {
  const res = await fetch(`${CONFIG.API_BASE}/api/interpret`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data?.error?.message || "Interpret API error");
  }
  return data;
}

async function transcribeAudio(audioBase64, sampleRateHz, channelCount) {
  const res = await fetch(`${CONFIG.API_BASE}/api/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      audio_base64: audioBase64,
      sample_rate_hz: sampleRateHz,
      language_code: "zh-TW",
      channel_count: channelCount || null
    })
  });
  const data = await res.json();
  if (!res.ok) {
    const detail = data?.detail;
    const message = detail?.message || "Transcribe API error";
    const details = detail?.details ? ` | ${JSON.stringify(detail.details)}` : "";
    throw new Error(`${message}${details}`);
  }
  if (data.error) {
    throw new Error(data?.error?.message || "Transcribe API error");
  }
  return data.text || "";
}

async function searchPlaces(parsed) {
  const res = await fetch(`${CONFIG.API_BASE}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      lat: state.lat,
      lng: state.lng,
      radius_m: parsed.radius_m,
      query: parsed.query,
      weight_mode: parsed.weight_mode,
      brand_strict: parsed.brand_strict
    })
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data?.error?.message || "Search API error");
  }
  return data;
}


function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result || "";
      const base64 = dataUrl.toString().split(",")[1] || "";
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function loadGoogleMaps(apiKey) {
  return new Promise((resolve, reject) => {
    if (!apiKey) {
      reject(new Error("MAPS_JS_API_KEY not set"));
      return;
    }
    window.initMap = function () {
      map = new google.maps.Map(document.getElementById("map"), {
        center: { lat: 25.033, lng: 121.5654 },
        zoom: 14,
        styles: [
          { elementType: "geometry", stylers: [{ color: "#0f172a" }] },
          { elementType: "labels.text.stroke", stylers: [{ color: "#0b1220" }] },
          { elementType: "labels.text.fill", stylers: [{ color: "#94a3b8" }] },
          { featureType: "administrative", elementType: "geometry", stylers: [{ color: "#334155" }] },
          { featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#86efac" }] },
          { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#0b2f24" }] },
          { featureType: "road", elementType: "geometry", stylers: [{ color: "#1f2937" }] },
          { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#111827" }] },
          { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#9ca3af" }] },
          { featureType: "transit", elementType: "geometry", stylers: [{ color: "#1f2937" }] },
          { featureType: "water", elementType: "geometry", stylers: [{ color: "#0b1628" }] },
          { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#7dd3fc" }] }
        ]
      });
      resolve();
    };
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&callback=initMap`;
    script.async = true;
    script.defer = true;
    script.onerror = () => reject(new Error("Failed to load Google Maps"));
    document.head.appendChild(script);
  });
}

async function initTurnstile(siteKey) {
  return new Promise((resolve) => {
    window.turnstileCallback = function(token) {
      turnstileToken = token;
      resolve(token);
    };
    
    // Wait for Turnstile to be loaded
    const checkTurnstile = setInterval(() => {
      if (window.turnstile) {
        clearInterval(checkTurnstile);
        const container = document.querySelector('.cf-turnstile');
        if (container) {
          container.setAttribute('data-callback', 'turnstileCallback');
          container.setAttribute('data-sitekey', siteKey);
          window.turnstile.render(container);
        }
      }
    }, 100);
  });
}

async function autoGetLocation() {
  try {
    const coords = await getLocation();
    state.lat = coords.latitude;
    state.lng = coords.longitude;
    updateCoordsLabel();
    if (map) map.setCenter({ lat: state.lat, lng: state.lng });
  } catch (e) {
    setStatus("error", `定位失敗: ${e.message}`);
    document.getElementById("coords").textContent = "定位失敗";
  }
}

async function boot() {
  try {
    const res = await fetch(`${CONFIG.API_BASE}/config`);
    const data = await res.json();
    
    // Initialize Turnstile
    if (data.turnstile_site_key) {
      const container = document.querySelector('.cf-turnstile');
      if (container) {
        container.setAttribute('data-sitekey', data.turnstile_site_key);
      }
    }
    
    await loadGoogleMaps(data.maps_js_api_key);
    
    // Auto get location on page load
    await autoGetLocation();
  } catch (e) {
    setStatus("error", e.message);
  }

  async function runFlow(text) {
    if (state.lat === null || state.lng === null) {
      setStatus("error", "請先取得定位");
      return;
    }
    if (!text) {
      setStatus("error", "請輸入自然語言描述");
      return;
    }
    try {
      setStatus("loading", "解析需求中...");
      const parsed = await interpretText(text);
      updateParsedView(parsed);

      setStatus("loading", "搜尋中...");
      const result = await searchPlaces(parsed);
      state.results = result.items || [];
      setResultCount(state.results.length);
      renderResults();

      if (state.results[0]) {
        map.panTo({ lat: state.results[0].lat, lng: state.results[0].lng });
        highlightCard(state.results[0].id);
      }
      setStatus("info", "完成");
    } catch (e) {
      setStatus("error", e.message);
    }
  }

  const input = document.getElementById("nlInput");
  input.focus();
  updateCharCount();
  input.addEventListener("input", updateCharCount);
  input.addEventListener("keydown", async (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      await runFlow(input.value.trim());
    }
  });

  document.querySelectorAll("[data-example]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      input.value = btn.getAttribute("data-example") || "";
      updateCharCount();
      await runFlow(input.value.trim());
    });
  });

  document.querySelectorAll("[data-append]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const appendText = btn.getAttribute("data-append") || "";
      if (!input.value) {
        input.value = appendText.trim();
      } else {
        input.value = `${input.value.trim()}${appendText}`;
      }
      updateCharCount();
      input.focus();
    });
  });

  document.getElementById("clearBtn").addEventListener("click", () => {
    input.value = "";
    updateCharCount();
    input.focus();
  });

  document.getElementById("searchBtn").addEventListener("click", async () => {
    await runFlow(input.value.trim());
  });

  document.getElementById("recordBtn").addEventListener("click", async () => {
    if (isRecording) {
      if (mediaRecorder) {
        mediaRecorder.stop();
      }
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      mediaRecorder = new MediaRecorder(stream, { mimeType });
      recordedChunks = [];
      isRecording = true;
      document.getElementById("recordBtn").textContent = "停止錄音";
      setStatus("loading", "錄音中...");

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          recordedChunks.push(e.data);
        }
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        isRecording = false;
        document.getElementById("recordBtn").textContent = "語音輸入";
        try {
          setStatus("loading", "語音轉文字中...");
          const blob = new Blob(recordedChunks, { type: mimeType });
          const base64 = await blobToBase64(blob);
          const track = stream.getAudioTracks()[0];
          const settings = track?.getSettings ? track.getSettings() : {};
          const sampleRateHz = settings.sampleRate || 48000;
          const channelCount = settings.channelCount || 1;
          const transcript = await transcribeAudio(base64, sampleRateHz, channelCount);
          if (!transcript) {
            setStatus("error", "語音辨識結果為空");
            return;
          }
          input.value = transcript;
          updateCharCount();
          await runFlow(transcript);
        } catch (e) {
          setStatus("error", e.message || "語音辨識失敗");
        }
      };

      mediaRecorder.start();
    } catch (e) {
      isRecording = false;
      document.getElementById("recordBtn").textContent = "語音輸入";
      setStatus("error", e.message || "無法取得麥克風");
    }
  });
}

document.addEventListener("DOMContentLoaded", boot);
