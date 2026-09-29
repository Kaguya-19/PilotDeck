import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import AgentModelSections from "./index";

const mocks = vi.hoisted(() => ({ commitRaw: vi.fn(), authenticatedFetch: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../../../utils/api", () => ({ authenticatedFetch: mocks.authenticatedFetch }));
vi.mock("../../../../hooks/usePilotDeckConfig", () => ({
  usePilotDeckConfig: () => ({
    raw: JSON.stringify({
      agent: { model: "HXAPI/old" },
      model: { providers: { HXAPI: { protocol: "openai", url: "https://example.test/v1", apiKey: "********", models: { old: {}, untested: {} } } } },
    }),
    commitRaw: mocks.commitRaw, loading: false, error: null,
  }),
}));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("optional model connection tests", () => {
  it("saves an untested primary model directly, preserving the provider ID", async () => {
    mocks.commitRaw.mockResolvedValue(undefined);
    render(<AgentModelSections title="Agent model" />);
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "HXAPI/untested" } });
    await waitFor(() => expect(mocks.commitRaw).toHaveBeenCalledOnce());
    expect(parse(mocks.commitRaw.mock.calls[0][0]).agent.model).toBe("HXAPI/untested");
    expect(mocks.authenticatedFetch).not.toHaveBeenCalled();
  });

  it("shows a configuration save failure", async () => {
    mocks.commitRaw.mockRejectedValue(new Error("Unable to save config"));
    render(<AgentModelSections title="Agent model" />);
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "HXAPI/untested" } });
    expect(await screen.findByText("Unable to save config")).toBeTruthy();
  });
});
