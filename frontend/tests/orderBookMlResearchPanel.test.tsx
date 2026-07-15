// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrderBookMlResearchPanel } from "../src/arbitrage/OrderBookMlResearchPanel";
import { PredictionResult } from "../src/arbitrage/OrderBookMlResearchResults";
import { ENVELOPE_BOUNDARY, EXECUTION_BOUNDARY, MODEL_ID, MODEL_SUMMARY, STATUS_RESPONSE, snapshot } from "./orderBookMlResearchFixtures";

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("order-book ML research panel", () => {
  it("states the anonymous, non-probability and non-execution boundary in EN/RU/KK", () => {
    const expected = {
      en: ["Anonymous order-book pattern lab", "participant identity is never inferred", "neither a probability nor a trading signal", "paper and live orders are disabled", "Online capture is unavailable"],
      ru: ["Лаборатория анонимных паттернов стакана", "личности участников не определяются", "не вероятность и не торговый сигнал", "paper- и live-ордера запрещены", "Онлайн-сбор отсутствует"],
      kk: ["Анонимді стакан паттерндері зертханасы", "қатысушы тұлғасы анықталмайды", "ықтималдық та, сауда сигналы да емес", "paper және live order тыйым салынған", "Online capture жоқ"]
    } as const;
    for (const locale of ["en", "ru", "kk"] as const) {
      const html = renderToStaticMarkup(<OrderBookMlResearchPanel locale={locale} />);
      for (const phrase of expected[locale]) expect(html).toContain(phrase);
      expect(html).toContain('aria-labelledby="obml-title"');
      expect(html).not.toMatch(/Place order|Buy now|Sell now/);
    }
  });

  it("renders native session/upload/training/inference forms and focuses invalid JSON errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(STATUS_RESPONSE));
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<OrderBookMlResearchPanel locale="ru" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(container.querySelectorAll("form")).toHaveLength(4);
    expect(container.querySelectorAll("fieldset").length).toBeGreaterThanOrEqual(6);
    expect(container.textContent).toContain("BTC anonymous liquidity");
    expect(container.textContent).toContain("sequence-gap: 1");
    expect(container.textContent).toContain("Метрики out-of-sample split");
    expect(container.querySelectorAll("table")).toHaveLength(1);

    const textarea = container.querySelector<HTMLTextAreaElement>("#obml-upload-json")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "{}");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const alert = container.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain("JSON снимков некорректны");
    expect(document.activeElement).toBe(alert);
    expect(fetchMock).toHaveBeenCalledOnce();

    const initialSignal = (fetchMock.mock.calls[0]?.[1] as RequestInit).signal;
    await act(async () => root.unmount());
    expect(initialSignal?.aborted).toBe(true);
  });

  it("shows bps, direction, OOD distance, contributions and provenance without a probability claim", () => {
    const html = renderToStaticMarkup(
      <PredictionResult
        locale="en"
        result={{
          prediction: {
            schemaVersion: "orderbook-prediction-v1",
            modelId: MODEL_ID,
            instrumentId: "test-venue:spot:BTCUSDT",
            symbol: "BTCUSDT",
            horizonMs: 1_000,
            anchorSequence: 121,
            anchorExchangeTs: 2_100,
            predictedReturnBps: 0.25,
            direction: "up",
            signalToNoise: 0.8,
            distribution: { status: "out-of-distribution", maximumAbsoluteZScore: 7, threshold: 6 },
            contributions: [{ feature: "spreadBps", standardizedValue: 0.5, contributionBps: 0.1 }],
            behaviorScope: "anonymous-aggregate-liquidity",
            participantIdentityInferred: false,
            executionBoundary: EXECUTION_BOUNDARY
          },
          provenance: { captureMode: "caller-uploaded-fresh-sequenced-l2", snapshots: 1, featureSchemaVersion: "orderbook-feature-v1", normalizerVersion: "test-l2-v1", qualityEvaluatedAt: 2_101 }
        }}
      />
    );
    expect(html).toContain("0.25 bps");
    expect(html).toContain("out of distribution");
    expect(html).toContain("spreadBps");
    expect(html).toContain("caller-uploaded fresh snapshot");
    expect(html).toContain("No probability is produced");
    expect(html).toContain(MODEL_ID);
    expect(html).toContain("BTCUSDT · test-venue:spot:BTCUSDT");
    expect(html).toContain("Anchor sequence");
  });

  it("localizes and focuses an unavailable status request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network unavailable")));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<OrderBookMlResearchPanel locale="kk" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const alert = container.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain("Зерттеу статусы қолжетімсіз");
    expect(document.activeElement).toBe(alert);
    await act(async () => root.unmount());
  });

  it("aborts an in-flight controller created by run when the panel unmounts", async () => {
    let runSignal: AbortSignal | undefined;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(STATUS_RESPONSE))
      .mockImplementationOnce((_url, init: RequestInit) => {
        runSignal = init.signal ?? undefined;
        return new Promise((_resolve, reject) => runSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
      });
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<OrderBookMlResearchPanel locale="en" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const refresh = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Refresh status"));
    await act(async () => refresh?.click());
    expect(runSignal?.aborted).toBe(false);
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    expect(runSignal?.aborted).toBe(true);
  });

  it("clears stale predictions on model selection, failed inference and training", async () => {
    const secondModelId = `ob-ridge:${"b".repeat(64)}`;
    const status = structuredClone(STATUS_RESPONSE) as unknown as Record<string, any>;
    status.health.registry.models = 2;
    status.sessions[0].models.push({ ...MODEL_SUMMARY, modelId: secondModelId });
    const current = snapshot(121, 2_100);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(status))
      .mockResolvedValueOnce(response(predictionEnvelope(MODEL_ID, current)))
      .mockResolvedValueOnce(response(status))
      .mockResolvedValueOnce(response(predictionEnvelope(secondModelId, current)))
      .mockResolvedValueOnce(response(status))
      .mockResolvedValueOnce(errorResponse("inference-quality"))
      .mockResolvedValueOnce(response(predictionEnvelope(secondModelId, current)))
      .mockResolvedValueOnce(response(status))
      .mockResolvedValueOnce(errorResponse("research-validation"));
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<OrderBookMlResearchPanel locale="en" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const inference = container.querySelector<HTMLTextAreaElement>("#obml-inference-json")!;
    await setTextarea(inference, JSON.stringify([current]));
    const inferenceForm = inference.closest<HTMLFormElement>("form")!;

    await submit(inferenceForm);
    expect(container.querySelector("#obml-prediction-result")).not.toBeNull();
    expect(container.textContent).toContain(MODEL_ID);

    const modelRadios = container.querySelectorAll<HTMLInputElement>(".obml-model-picker input");
    await act(async () => modelRadios[1]?.click());
    expect(container.querySelector("#obml-prediction-result")).toBeNull();

    await submit(inferenceForm);
    expect(container.querySelector("#obml-prediction-result")).not.toBeNull();
    expect(container.textContent).toContain(secondModelId);

    await submit(inferenceForm);
    expect(container.querySelector("#obml-prediction-result")).toBeNull();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    await submit(inferenceForm);
    expect(container.querySelector("#obml-prediction-result")).not.toBeNull();
    const trainingForm = container.querySelector<HTMLSelectElement>("#obml-horizon")?.closest<HTMLFormElement>("form");
    if (!trainingForm) throw new Error("Missing training form");
    await submit(trainingForm);
    expect(container.querySelector("#obml-prediction-result")).toBeNull();
    await act(async () => root.unmount());
  });
});

function response(value: unknown) {
  return { ok: true, status: 200, json: async () => value };
}

function errorResponse(code: string) {
  return { ok: false, status: 422, json: async () => ({ ...ENVELOPE_BOUNDARY, error: { code, message: "rejected" } }) };
}

function predictionEnvelope(modelId: string, current: ReturnType<typeof snapshot>) {
  return {
    ...ENVELOPE_BOUNDARY,
    prediction: {
      schemaVersion: "orderbook-prediction-v1",
      modelId,
      instrumentId: current.instrumentId,
      symbol: current.symbol,
      horizonMs: 1_000,
      anchorSequence: current.sequence,
      anchorExchangeTs: current.exchangeTs,
      predictedReturnBps: 0.25,
      direction: "up",
      signalToNoise: 0.8,
      distribution: { status: "within-training-range", maximumAbsoluteZScore: 1.2, threshold: 6 },
      contributions: [{ feature: "spreadBps", standardizedValue: 0.5, contributionBps: 0.1 }],
      behaviorScope: "anonymous-aggregate-liquidity",
      participantIdentityInferred: false,
      executionBoundary: EXECUTION_BOUNDARY
    },
    provenance: { captureMode: "caller-uploaded-fresh-sequenced-l2", snapshots: 1, featureSchemaVersion: "orderbook-feature-v1", normalizerVersion: current.normalizerVersion, qualityEvaluatedAt: current.receivedAt }
  };
}

async function setTextarea(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
