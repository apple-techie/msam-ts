import { describe, it, expect } from "vitest";
import {
  getVisibleAgents,
  getDiscoveryMode,
  type CrossDiscoveryConfig,
} from "../../src/agents/cross-discovery.js";

const baseConfig: CrossDiscoveryConfig = {
  enabled: true,
  groups: [
    {
      name: "gateway-one-fleet",
      agents: ["gateway-one", "gateway-one-c", "gateway-one-a", "gateway-one-b", "gateway-one-d", "main"],
    },
    {
      name: "gateway-two-fleet",
      agents: ["gateway-two", "gateway-two-a", "gateway-two-b", "gateway-two-c", "gateway-two-d"],
    },
  ],
  bridges: [
    { from: "gateway-one-fleet", to: "gateway-two-fleet", mode: "entities-only" },
  ],
};

const fullBridgeConfig: CrossDiscoveryConfig = {
  ...baseConfig,
  bridges: [
    { from: "gateway-one-fleet", to: "gateway-two-fleet", mode: "full" },
  ],
};

const offBridgeConfig: CrossDiscoveryConfig = {
  ...baseConfig,
  bridges: [
    { from: "gateway-one-fleet", to: "gateway-two-fleet", mode: "off" },
  ],
};

const noBridgeConfig: CrossDiscoveryConfig = {
  ...baseConfig,
  bridges: [],
};

const disabledConfig: CrossDiscoveryConfig = {
  enabled: false,
  groups: baseConfig.groups,
  bridges: baseConfig.bridges,
};

describe("cross-discovery", () => {
  describe("getVisibleAgents", () => {
    it("returns all agents in same group + bridged group agents", () => {
      const visible = getVisibleAgents("gateway-one", baseConfig);
      expect(visible).toContain("gateway-one");
      expect(visible).toContain("gateway-one-c");
      expect(visible).toContain("gateway-one-d");
      expect(visible).toContain("gateway-two");
      expect(visible).toContain("gateway-two-a");
      expect(visible.length).toBe(11);
    });

    it("returns only own group when bridge is off", () => {
      const visible = getVisibleAgents("gateway-one", offBridgeConfig);
      expect(visible).toContain("gateway-one");
      expect(visible).toContain("gateway-one-d");
      expect(visible).not.toContain("gateway-two");
      expect(visible.length).toBe(6);
    });

    it("returns only own group when no bridge exists", () => {
      const visible = getVisibleAgents("gateway-one", noBridgeConfig);
      expect(visible).toContain("gateway-one");
      expect(visible).not.toContain("gateway-two");
      expect(visible.length).toBe(6);
    });

    it("returns only itself when agent not in any group", () => {
      const visible = getVisibleAgents("system-alpha", baseConfig);
      expect(visible).toEqual(["system-alpha"]);
    });

    it("returns only itself when discovery is disabled", () => {
      const visible = getVisibleAgents("gateway-one", disabledConfig);
      expect(visible).toEqual(["gateway-one"]);
    });

    it("works from the other group's perspective", () => {
      const visible = getVisibleAgents("gateway-two", baseConfig);
      expect(visible).toContain("gateway-two");
      expect(visible).toContain("gateway-two-a");
      expect(visible).toContain("gateway-one");
      expect(visible.length).toBe(11);
    });
  });

  describe("getDiscoveryMode", () => {
    it("returns full for agents in the same group", () => {
      expect(getDiscoveryMode("gateway-one", "gateway-one-d", baseConfig)).toBe("full");
    });

    it("returns full for same agent", () => {
      expect(getDiscoveryMode("gateway-one", "gateway-one", baseConfig)).toBe("full");
    });

    it("returns bridge mode for agents in bridged groups", () => {
      expect(getDiscoveryMode("gateway-one", "gateway-two", baseConfig)).toBe("entities-only");
    });

    it("returns full for full-mode bridge", () => {
      expect(getDiscoveryMode("gateway-one", "gateway-two", fullBridgeConfig)).toBe("full");
    });

    it("returns off for off-mode bridge", () => {
      expect(getDiscoveryMode("gateway-one", "gateway-two", offBridgeConfig)).toBe("off");
    });

    it("returns off when no bridge exists", () => {
      expect(getDiscoveryMode("gateway-one", "gateway-two", noBridgeConfig)).toBe("off");
    });

    it("returns off when agent not in any group", () => {
      expect(getDiscoveryMode("system-alpha", "gateway-one", baseConfig)).toBe("off");
    });

    it("returns off when neither agent is in a group", () => {
      expect(getDiscoveryMode("system-alpha", "sam", baseConfig)).toBe("off");
    });

    it("returns off when discovery is disabled", () => {
      expect(getDiscoveryMode("gateway-one", "gateway-one-d", disabledConfig)).toBe("off");
    });

    it("is symmetric for bridged groups", () => {
      const ab = getDiscoveryMode("gateway-one", "gateway-two", baseConfig);
      const ba = getDiscoveryMode("gateway-two", "gateway-one", baseConfig);
      expect(ab).toBe(ba);
    });
  });

  describe("config schema integration", () => {
    it("parses cross_discovery from TOML config", async () => {
      const { loadConfigFromString, resetConfig } = await import("../../src/config/index.js");
      resetConfig();

      const cfg = loadConfigFromString(`
[agents]
default_agent_id = "gateway-one"

[agents.cross_discovery]
enabled = true

[[agents.cross_discovery.groups]]
name = "fleet-a"
agents = ["agent1", "agent2"]

[[agents.cross_discovery.groups]]
name = "fleet-b"
agents = ["agent3", "agent4"]

[[agents.cross_discovery.bridges]]
from = "fleet-a"
to = "fleet-b"
mode = "entities-only"
`);

      expect(cfg.agents.cross_discovery.enabled).toBe(true);
      expect(cfg.agents.cross_discovery.groups).toHaveLength(2);
      expect(cfg.agents.cross_discovery.groups[0].name).toBe("fleet-a");
      expect(cfg.agents.cross_discovery.groups[0].agents).toEqual(["agent1", "agent2"]);
      expect(cfg.agents.cross_discovery.bridges).toHaveLength(1);
      expect(cfg.agents.cross_discovery.bridges[0].mode).toBe("entities-only");

      resetConfig();
    });

    it("defaults to disabled with empty groups and bridges", async () => {
      const { loadConfigFromString, resetConfig } = await import("../../src/config/index.js");
      resetConfig();

      const cfg = loadConfigFromString(`
[agents]
default_agent_id = "gateway-one"
`);

      expect(cfg.agents.cross_discovery.enabled).toBe(false);
      expect(cfg.agents.cross_discovery.groups).toEqual([]);
      expect(cfg.agents.cross_discovery.bridges).toEqual([]);

      resetConfig();
    });
  });

  describe("bridge mode filtering", () => {
    it("entities-only mode does not imply full access", () => {
      const mode = getDiscoveryMode("gateway-one", "gateway-two", baseConfig);
      expect(mode).toBe("entities-only");
      expect(mode).not.toBe("full");
    });

    it("three groups with selective bridges", () => {
      const threeGroupConfig: CrossDiscoveryConfig = {
        enabled: true,
        groups: [
          { name: "group-a", agents: ["a1", "a2"] },
          { name: "group-b", agents: ["b1", "b2"] },
          { name: "group-c", agents: ["c1", "c2"] },
        ],
        bridges: [
          { from: "group-a", to: "group-b", mode: "full" },
        ],
      };

      expect(getDiscoveryMode("a1", "b1", threeGroupConfig)).toBe("full");
      expect(getDiscoveryMode("a1", "c1", threeGroupConfig)).toBe("off");
      expect(getDiscoveryMode("b1", "c1", threeGroupConfig)).toBe("off");
      expect(getDiscoveryMode("a1", "a2", threeGroupConfig)).toBe("full");

      const visibleA = getVisibleAgents("a1", threeGroupConfig);
      expect(visibleA).toContain("b1");
      expect(visibleA).not.toContain("c1");

      const visibleC = getVisibleAgents("c1", threeGroupConfig);
      expect(visibleC).toEqual(["c1", "c2"]);
    });
  });
});
