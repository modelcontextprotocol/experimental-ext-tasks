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
        { text: "SEPs", link: "/seps/2663-tasks-extension" },
        { text: "Specification", link: "/specification/draft/tasks" },
      ],

      sidebar: {
        "specification/": [
          {
            text: "Specification",
            items: [{ text: "Draft", link: "/specification/draft/tasks" }],
          },
        ],
        "seps/": [
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
