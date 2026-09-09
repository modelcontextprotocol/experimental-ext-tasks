import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

export default withMermaid(
  defineConfig({
    title: "MCP Tasks Extension",
    description: "Documentation for the MCP Tasks extension",

    head: [["link", { rel: "icon", href: "/mcp.png" }]],

    themeConfig: {
      outline: [2, 3],

      nav: [
        { text: "SDK", link: "/typescript/" },
        { text: "SEPs", link: "/seps/2663-tasks-extension" },
        { text: "Specification", link: "/specification/2026-07-28/tasks" },
      ],

      sidebar: {
        "/typescript/": [
          {
            text: "Introduction",
            items: [
              { text: "Getting started", link: "/typescript/" },
              {
                text: "Call your first tool",
                link: "/typescript/getting-started",
              },
              {
                text: "Migrate from the base SDK",
                link: "/typescript/migrating-from-the-sdk",
              },
            ],
          },
          {
            text: "Clients",
            items: [
              {
                text: "Observe and control execution",
                link: "/typescript/client/execution",
              },
              {
                text: "Handle input and recover tasks",
                link: "/typescript/client/input-and-recovery",
              },
              {
                text: "[2025-11-25] Receive sampling and elicitation requests",
                link: "/typescript/receiver",
              },
            ],
          },
          {
            text: "Advanced",
            items: [
              {
                text: "Integrate adapters and schemas",
                link: "/typescript/adapters-and-schemas",
              },
            ],
          },
          {
            text: "Help",
            items: [
              { text: "Troubleshooting", link: "/typescript/troubleshooting" },
            ],
          },
        ],
        "/specification/": [
          {
            text: "Specification",
            items: [
              {
                text: "2026-07-28",
                link: "/specification/2026-07-28/tasks",
              },
              { text: "Draft", link: "/specification/draft/tasks" },
            ],
          },
        ],
        "/seps/": [
          {
            text: "SEPs",
            items: [
              { text: "SEP-1686: Tasks", link: "/seps/1686-tasks" },
              {
                text: "SEP-2663: Tasks Extension",
                link: "/seps/2663-tasks-extension",
              },
            ],
          },
        ],
      },

      socialLinks: [
        {
          icon: "github",
          link: "https://github.com/modelcontextprotocol/ext-tasks",
        },
      ],

      search: {
        provider: "local",
      },
    },
  }),
);
