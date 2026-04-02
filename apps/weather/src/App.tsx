import { useState, useEffect, useRef, useCallback } from "react";
import { connect, WindowMessenger } from "penpal";

interface AppStateSummary {
  raw: Record<string, unknown>;
  display: string;
}

interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  displayText?: string;
}

interface AppInitConfig {
  sessionId: string;
  theme: "light" | "dark";
  locale: string;
}

interface PlatformMethods {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  [index: string]: PlatformMethods | Function;
  notifyStateUpdate(state: AppStateSummary): Promise<void>;
  signalCompletion(event: string, summary: string): Promise<void>;
  requestResize(height: number): Promise<void>;
}

interface GeoResult {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
}

interface WeatherBundle {
  location: GeoResult;
  current: {
    tempC: number;
    windKmh: number;
    humidity: number;
    code: number;
    condition: string;
  };
  daily: Array<{
    date: string;
    maxC: number;
    minC: number;
    code: number;
    condition: string;
  }>;
}

async function geocodeCity(name: string): Promise<GeoResult | null> {
  const q = encodeURIComponent(name.trim());
  const res = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${q}&count=1&language=en&format=json`,
  );
  if (!res.ok) return null;
  const data = (await res.json()) as {
    results?: Array<{
      name: string;
      latitude: number;
      longitude: number;
      country?: string;
    }>;
  };
  const r = data.results?.[0];
  if (!r) return null;
  return {
    name: r.name,
    latitude: r.latitude,
    longitude: r.longitude,
    country: r.country,
  };
}

function wmoLabel(code: number): string {
  const m: Record<number, string> = {
    0: "Clear",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Fog",
    51: "Light drizzle",
    53: "Drizzle",
    55: "Heavy drizzle",
    61: "Light rain",
    63: "Rain",
    65: "Heavy rain",
    71: "Snow",
    73: "Snow",
    75: "Heavy snow",
    80: "Rain showers",
    81: "Rain showers",
    82: "Violent rain showers",
    95: "Thunderstorm",
    96: "Thunderstorm w/ hail",
    99: "Thunderstorm w/ hail",
  };
  return m[code] ?? "Unknown";
}

async function fetchWeatherBundle(location: string): Promise<WeatherBundle | null> {
  const geo = await geocodeCity(location);
  if (!geo) return null;

  const lat = geo.latitude;
  const lon = geo.longitude;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    "&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min" +
    "&timezone=auto&forecast_days=7";

  const res = await fetch(url);
  if (!res.ok) return null;
  const j = (await res.json()) as {
    current?: {
      temperature_2m: number;
      relative_humidity_2m: number;
      wind_speed_10m: number;
      weather_code: number;
    };
    daily?: {
      time: string[];
      weather_code: number[];
      temperature_2m_max: number[];
      temperature_2m_min: number[];
    };
  };

  const cur = j.current;
  const daily = j.daily;
  if (!cur || !daily?.time?.length) return null;

  const days = daily.time.slice(0, 7).map((date, i) => ({
    date,
    maxC: daily.temperature_2m_max[i] ?? 0,
    minC: daily.temperature_2m_min[i] ?? 0,
    code: daily.weather_code[i] ?? 0,
    condition: wmoLabel(daily.weather_code[i] ?? 0),
  }));

  return {
    location: geo,
    current: {
      tempC: cur.temperature_2m,
      windKmh: cur.wind_speed_10m,
      humidity: cur.relative_humidity_2m,
      code: cur.weather_code,
      condition: wmoLabel(cur.weather_code),
    },
    daily: days,
  };
}

function fahrenheit(c: number): number {
  return Math.round((c * 9) / 5 + 32);
}

function displayLocation(geo: GeoResult): string {
  return geo.country ? `${geo.name}, ${geo.country}` : geo.name;
}

export default function App() {
  const [bundle, setBundle] = useState<WeatherBundle | null>(null);
  const [status, setStatus] = useState("Ask the chatbot for weather in a city.");
  const [connectionState, setConnectionState] = useState<
    "connecting" | "connected" | "error"
  >("connecting");

  const parentRef = useRef<PlatformMethods | null>(null);
  const bundleRef = useRef<WeatherBundle | null>(null);
  bundleRef.current = bundle;

  const getStateSummary = useCallback((): AppStateSummary => {
    const b = bundleRef.current;
    if (!b) {
      return { raw: {}, display: "No weather loaded" };
    }
    const loc = displayLocation(b.location);
    return {
      raw: {
        location: loc,
        tempF: fahrenheit(b.current.tempC),
        condition: b.current.condition,
      },
      display: `${loc}: ${fahrenheit(b.current.tempC)}°F, ${b.current.condition}`,
    };
  }, []);

  const notifyParent = useCallback(async () => {
    if (parentRef.current) {
      try {
        await parentRef.current.notifyStateUpdate(getStateSummary());
      } catch {
        /* ignore */
      }
    }
  }, [getStateSummary]);

  const handleGetWeather = useCallback(
    async (params: Record<string, unknown>): Promise<ToolResult> => {
      const location = (params.location as string)?.trim();
      if (!location) {
        return {
          success: false,
          error: "Missing location",
          displayText: "Please specify a city or place name for the weather.",
        };
      }

      setStatus(`Loading weather for ${location}…`);
      const data = await fetchWeatherBundle(location);
      if (!data) {
        setStatus("Could not find weather data.");
        return {
          success: false,
          error: "Geocode or forecast failed",
          displayText: `Could not find weather data for "${location}". Try a different spelling or a nearby city.`,
        };
      }

      setBundle(data);
      const loc = displayLocation(data.location);
      const tempF = fahrenheit(data.current.tempC);
      const displayText = `Current weather in ${loc}: ${tempF}°F, ${data.current.condition}. Wind: ${Math.round(data.current.windKmh * 0.621371)} mph. Humidity: ${data.current.humidity}%.`;

      setStatus(displayText);
      await notifyParent();

      if (parentRef.current) {
        try {
          await parentRef.current.signalCompletion(
            "data_loaded",
            `Weather for ${loc}: ${tempF}°F, ${data.current.condition}`,
          );
        } catch {
          /* ignore */
        }
      }

      try {
        await parentRef.current?.requestResize(420);
      } catch {
        /* ignore */
      }

      return {
        success: true,
        data: {
          location: loc,
          tempC: data.current.tempC,
          tempF,
          condition: data.current.condition,
          windKmh: data.current.windKmh,
          humidity: data.current.humidity,
        },
        displayText,
      };
    },
    [notifyParent],
  );

  const handleGetForecast = useCallback(
    async (params: Record<string, unknown>): Promise<ToolResult> => {
      const location = (params.location as string)?.trim();
      const days = Math.min(
        7,
        Math.max(1, Number(params.days) || 3),
      );

      if (!location) {
        return {
          success: false,
          error: "Missing location",
          displayText: "Please specify a location for the forecast.",
        };
      }

      setStatus(`Loading ${days}-day forecast for ${location}…`);
      const data = await fetchWeatherBundle(location);
      if (!data) {
        return {
          success: false,
          error: "Forecast failed",
          displayText: `Could not load forecast for "${location}".`,
        };
      }

      setBundle(data);
      const slice = data.daily.slice(0, days);
      const loc = displayLocation(data.location);
      const lines = slice.map(
        (d) =>
          `${d.date}: ${fahrenheit(d.minC)}–${fahrenheit(d.maxC)}°F, ${d.condition}`,
      );
      const displayText = `${days}-day forecast for ${loc}: ${lines.join("; ")}.`;

      setStatus(displayText);
      await notifyParent();

      try {
        await parentRef.current?.requestResize(420);
      } catch {
        /* ignore */
      }

      return {
        success: true,
        data: { location: loc, days: slice },
        displayText,
      };
    },
    [notifyParent],
  );

  const handleGetWeatherRef = useRef(handleGetWeather);
  const handleGetForecastRef = useRef(handleGetForecast);
  const getStateSummaryRef = useRef(getStateSummary);
  handleGetWeatherRef.current = handleGetWeather;
  handleGetForecastRef.current = handleGetForecast;
  getStateSummaryRef.current = getStateSummary;

  useEffect(() => {
    const messenger = new WindowMessenger({
      remoteWindow: window.parent,
      allowedOrigins: ["*"],
    });

    const connection = connect<PlatformMethods>({
      messenger,
      methods: {
        async initialize(config: AppInitConfig) {
          console.log("[Weather] initialize:", config);
        },
        async invokeTool(
          toolName: string,
          params: Record<string, unknown>,
        ): Promise<ToolResult> {
          switch (toolName) {
            case "get_weather":
              return handleGetWeatherRef.current(params);
            case "get_forecast":
              return handleGetForecastRef.current(params);
            default:
              return {
                success: false,
                error: `Unknown tool: ${toolName}`,
                displayText: `Unknown tool "${toolName}".`,
              };
          }
        },
        async getState(): Promise<AppStateSummary> {
          return getStateSummaryRef.current();
        },
        async destroy() {
          console.log("[Weather] destroy");
        },
      },
      timeout: 5000,
    });

    connection.promise
      .then(async (parent) => {
        parentRef.current = parent;
        setConnectionState("connected");
        await parent.notifyStateUpdate(getStateSummaryRef.current());
      })
      .catch((err) => {
        console.error("[Weather] Penpal failed:", err);
        setConnectionState("error");
      });

    return () => connection.destroy();
  }, []);

  const locLabel = bundle ? displayLocation(bundle.location) : null;

  return (
    <div className="flex min-h-screen flex-col bg-gray-900 p-4 text-gray-100">
      <h1 className="text-center text-base font-semibold">Weather</h1>
      <p className="mb-3 text-center text-xs text-gray-400">{status}</p>

      {connectionState === "connecting" && (
        <div className="flex justify-center gap-2 text-sm text-gray-400">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-600 border-t-sky-500" />
          Connecting…
        </div>
      )}
      {connectionState === "error" && (
        <p className="text-center text-sm text-red-400">Failed to connect to platform.</p>
      )}

      {bundle && (
        <div className="mx-auto w-full max-w-sm rounded-xl border border-gray-700 bg-gray-800/80 p-4 shadow-lg">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
            {locLabel}
          </p>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-4xl font-semibold text-white">
              {fahrenheit(bundle.current.tempC)}°
            </span>
            <span className="text-sm text-gray-400">F</span>
            <span className="ml-auto text-sm text-gray-300">
              {bundle.current.condition}
            </span>
          </div>
          <div className="mt-3 flex gap-4 text-xs text-gray-400">
            <span>Wind {Math.round(bundle.current.windKmh * 0.621371)} mph</span>
            <span>Humidity {bundle.current.humidity}%</span>
          </div>
          <div className="mt-4 border-t border-gray-700 pt-3">
            <p className="mb-2 text-xs text-gray-500">Next 3 days</p>
            <div className="flex justify-between gap-1">
              {bundle.daily.slice(0, 3).map((d) => (
                <div
                  key={d.date}
                  className="flex flex-1 flex-col items-center rounded-lg bg-gray-900/60 px-1 py-2 text-center"
                >
                  <span className="text-[10px] text-gray-500">{d.date.slice(5)}</span>
                  <span className="text-sm font-medium text-gray-200">
                    {fahrenheit(d.maxC)}°
                  </span>
                  <span className="text-[10px] text-gray-500">
                    {fahrenheit(d.minC)}°
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
