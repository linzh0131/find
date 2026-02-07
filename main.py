import json
import math
import os
from typing import Any, Dict, List, Iterable

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

load_dotenv()

PLACES_API_KEY = os.environ.get("PLACES_API_KEY", "").strip()
MAPS_JS_API_KEY = os.environ.get("MAPS_JS_API_KEY", "").strip()
SPEECH_API_KEY = os.environ.get("SPEECH_API_KEY", "").strip()
GEMINI_API_KEY = (
    os.environ.get("GEMINI_API_KEY", "")
    or os.environ.get("API_KEY", "")
).strip()

PLACES_TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"
PLACES_FIELD_MASK = (
    "places.id,places.displayName,places.location,places.rating,places.userRatingCount,"
    "places.formattedAddress,places.types,places.websiteUri,places.nationalPhoneNumber,"
    "places.businessStatus"
)
GEMINI_GENERATE_URL = (
    "https://aiplatform.googleapis.com/v1/publishers/google/models/"
    "gemini-2.5-flash-lite:streamGenerateContent?key="
)
SPEECH_RECOGNIZE_URL = "https://speech.googleapis.com/v1/speech:recognize?key="


class SearchRequest(BaseModel):
    lat: float
    lng: float
    radius_m: int
    query: str
    weight_mode: str
    brand_strict: bool = False


class InterpretRequest(BaseModel):
    text: str


class TranscribeRequest(BaseModel):
    audio_base64: str
    sample_rate_hz: int = 48000
    language_code: str = "en-US"
    channel_count: int | None = None


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def get_weights(mode: str) -> (float, float):
    if mode == "distance_first":
        return 0.7, 0.2
    if mode == "rating_first":
        return 0.2, 0.7
    return 0.4, 0.4


def hot_score_from_count(user_rating_count: int) -> float:
    return min(user_rating_count / 1000.0, 1.0)


def pick_display_name(place: Dict[str, Any]) -> str:
    display = place.get("displayName") or {}
    if isinstance(display, dict):
        return display.get("text") or "Unknown"
    return str(display)


def normalize_weight_mode(value: str) -> str:
    if value in {"distance_first", "rating_first", "balance"}:
        return value
    return "balance"


def normalize_radius_m(value: Any) -> int:
    try:
        radius = int(float(value))
    except (TypeError, ValueError):
        return 1500
    return max(200, min(radius, 10000))


def normalize_query(value: Any) -> str:
    text = str(value or "").strip()
    return text or "store"


def normalize_brand_strict(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes"}
    return False


def normalize_for_match(text: str) -> str:
    return "".join(text.lower().split())


def flag_label(rating: float, rating_count: int) -> str | None:
    if rating_count < 30 and rating >= 4.5:
        return "評論少"
    return None


def _extract_gemini_text(payload: Any) -> str:
    if isinstance(payload, dict):
        return (
            payload.get("candidates", [{}])[0]
            .get("content", {})
            .get("parts", [{}])[0]
            .get("text", "")
        )
    if isinstance(payload, list):
        parts: List[str] = []
        for item in payload:
            text = _extract_gemini_text(item)
            if text:
                parts.append(text)
        return "".join(parts)
    return ""


def _decode_stream_objects(raw: str) -> Iterable[Any]:
    decoder = json.JSONDecoder()
    idx = 0
    length = len(raw)
    while idx < length:
        while idx < length and raw[idx].isspace():
            idx += 1
        if idx >= length:
            break
        try:
            obj, next_idx = decoder.raw_decode(raw, idx)
        except json.JSONDecodeError:
            break
        yield obj
        idx = next_idx


@app.get("/health")
def health() -> Dict[str, bool]:
    return {"ok": True}


@app.get("/config")
def config() -> Dict[str, str]:
    return {"maps_js_api_key": MAPS_JS_API_KEY}


@app.post("/api/interpret")
def interpret(req: InterpretRequest) -> Dict[str, Any]:
    if not GEMINI_API_KEY:
        return {"error": {"code": "MISSING_API_KEY", "message": "GEMINI_API_KEY not set"}}

    prompt = (
        "You are a parser for a local store search system. "
        "Extract best keyword, distance in meters, and sorting mode. "
        "Return ONLY valid JSON with keys: query, radius_m, weight_mode, brand_strict. "
        "weight_mode must be one of: balance, distance_first, rating_first. "
        "brand_strict must be true if the text clearly refers to a specific brand name. "
        "If distance/range is missing, use 1500. If keyword missing, use store.\n\n"
        f"User text: {req.text}"
    )

    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {
                        "text": prompt,
                    }
                ],
            }
        ],
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 200,
            "responseMimeType": "application/json",
            "responseSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "radius_m": {"type": "integer"},
                    "weight_mode": {
                        "type": "string",
                        "enum": ["balance", "distance_first", "rating_first"],
                    },
                    "brand_strict": {"type": "boolean"},
                },
                "required": ["query", "radius_m", "weight_mode", "brand_strict"],
                "additionalProperties": False,
            },
        },
    }

    headers = {
        "Content-Type": "application/json"
    }

    try:
        with httpx.Client(timeout=12) as client:
            resp = client.post(
                f"{GEMINI_GENERATE_URL}{GEMINI_API_KEY}",
                json=payload,
                headers=headers,
            )
    except httpx.RequestError as exc:
        return {"error": {"code": "UPSTREAM_ERROR", "message": str(exc)}}

    if resp.status_code >= 400:
        return {
            "error": {
                "code": "UPSTREAM_ERROR",
                "message": f"Gemini API error: {resp.status_code}",
            }
        }

    raw = resp.text
    try:
        data = json.loads(raw)
        text = _extract_gemini_text(data)
    except json.JSONDecodeError:
        parts = []
        for obj in _decode_stream_objects(raw):
            text_part = _extract_gemini_text(obj)
            if text_part:
                parts.append(text_part)
        text = "".join(parts)

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        # Attempt to salvage JSON embedded in text
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            try:
                parsed = json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                return {"error": {"code": "PARSE_ERROR", "message": "Gemini output not JSON"}}
        else:
            return {"error": {"code": "PARSE_ERROR", "message": "Gemini output not JSON"}}

    result = {
        "query": normalize_query(parsed.get("query")),
        "radius_m": normalize_radius_m(parsed.get("radius_m")),
        "weight_mode": normalize_weight_mode(parsed.get("weight_mode")),
        "brand_strict": normalize_brand_strict(parsed.get("brand_strict")),
    }
    return result


@app.post("/api/transcribe")
def transcribe(req: TranscribeRequest) -> Dict[str, Any]:
    if not SPEECH_API_KEY:
        raise HTTPException(status_code=400, detail={"code": "MISSING_API_KEY", "message": "SPEECH_API_KEY not set"})

    if not req.audio_base64:
        raise HTTPException(status_code=400, detail={"code": "INVALID_REQUEST", "message": "audio_base64 required"})

    config = {
        "encoding": "WEBM_OPUS",
        "sampleRateHertz": req.sample_rate_hz,
        "languageCode": req.language_code,
    }
    if req.channel_count:
        config["audioChannelCount"] = req.channel_count

    payload = {
        "config": config,
        "audio": {"content": req.audio_base64},
    }

    headers = {"Content-Type": "application/json"}

    try:
        with httpx.Client(timeout=20) as client:
            resp = client.post(
                f"{SPEECH_RECOGNIZE_URL}{SPEECH_API_KEY}",
                json=payload,
                headers=headers,
            )
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail={"code": "UPSTREAM_ERROR", "message": str(exc)})

    if resp.status_code >= 400:
        try:
            err = resp.json()
        except json.JSONDecodeError:
            err = {"message": resp.text}
        raise HTTPException(
            status_code=502,
            detail={
                "code": "UPSTREAM_ERROR",
                "message": f"Speech API error: {resp.status_code}",
                "details": err,
            },
        )

    data = resp.json()
    results = data.get("results", [])
    transcript_parts = []
    for result in results:
        alternatives = result.get("alternatives", [])
        if alternatives:
            transcript_parts.append(alternatives[0].get("transcript", ""))

    transcript = " ".join([t for t in transcript_parts if t]).strip()
    return {"text": transcript}


@app.post("/api/search")
def search(req: SearchRequest) -> Dict[str, Any]:
    if not PLACES_API_KEY:
        return {"error": {"code": "MISSING_API_KEY", "message": "PLACES_API_KEY not set"}}

    text_query = (req.query or "").strip() or "store"

    payload = {
        "textQuery": text_query,
        "locationBias": {
            "circle": {
                "center": {"latitude": req.lat, "longitude": req.lng},
                "radius": float(req.radius_m),
            }
        },
    }

    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": PLACES_API_KEY,
        "X-Goog-FieldMask": PLACES_FIELD_MASK,
    }

    try:
        with httpx.Client(timeout=10) as client:
            resp = client.post(PLACES_TEXT_SEARCH_URL, json=payload, headers=headers)
    except httpx.RequestError as exc:
        return {"error": {"code": "UPSTREAM_ERROR", "message": str(exc)}}

    if resp.status_code >= 400:
        return {
            "error": {
                "code": "UPSTREAM_ERROR",
                "message": f"Places API error: {resp.status_code}",
            }
        }

    data = resp.json()
    places = data.get("places", [])

    Wd, Wr = get_weights(req.weight_mode)
    items: List[Dict[str, Any]] = []
    top_place: Dict[str, Any] | None = None
    match_query = normalize_for_match(req.query or "")

    for place in places:
        location = place.get("location") or {}
        lat = location.get("latitude")
        lng = location.get("longitude")
        if lat is None or lng is None:
            continue

        distance_m = haversine_m(req.lat, req.lng, lat, lng)
        if distance_m > req.radius_m:
            continue

        rating = float(place.get("rating") or 0.0)
        rating_count = int(place.get("userRatingCount") or 0)
        distance_score = 1 - min(distance_m / req.radius_m, 1)
        rating_score = rating / 5 if rating else 0.0
        hot_score = hot_score_from_count(rating_count)
        score = (Wd * distance_score) + (Wr * rating_score) + hot_score

        place_name = pick_display_name(place)
        name_norm = normalize_for_match(place_name)
        if req.brand_strict and match_query:
            if match_query not in name_norm:
                continue

        item = {
            "id": place.get("id") or "",
            "name": place_name,
            "lat": lat,
            "lng": lng,
            "distance_m": distance_m,
            "rating": rating,
            "rating_count": rating_count,
            "hot_score": hot_score,
            "score": score,
            "flag_label": flag_label(rating, rating_count),
            "score_breakdown": {
                "distance_score": distance_score,
                "rating_score": rating_score,
                "hot_score": hot_score,
                "Wd": Wd,
                "Wr": Wr,
            },
        }
        items.append(item)

    items.sort(key=lambda x: x["score"], reverse=True)
    if items:
        top_place = next((p for p in places if (p.get("id") or "") == items[0]["id"]), None)

    return {"items": items}
