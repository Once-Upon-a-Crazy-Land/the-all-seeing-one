import assert from "node:assert/strict";
import { test } from "node:test";
import { composeEmbed, composeV2Container, EmbedInputError } from "../src/embed-composer.js";

test("composes Discord embed metadata and keeps unsupported properties out", () => {
  const embed = composeEmbed({
    title: "Announcement", description: "Starts at noon", url: "https://example.com/event",
    authorName: "Events team", authorUrl: "https://example.com/team", authorIcon: "https://example.com/team.png",
    footerText: "Community event", footerIcon: "https://example.com/footer.png",
    image: "https://example.com/banner.png", thumbnail: "https://example.com/thumbnail.png",
    color: "#000000", timestamp: "2026-11-13T12:00:00.000Z",
    fields: [{ name: "Location", value: "Main hall", inline: true }],
    video: { url: "https://example.com/video" }
  });
  assert.deepEqual(embed, {
    title: "Announcement", description: "Starts at noon", url: "https://example.com/event",
    author: { name: "Events team", url: "https://example.com/team", icon_url: "https://example.com/team.png" },
    footer: { text: "Community event", icon_url: "https://example.com/footer.png" },
    image: { url: "https://example.com/banner.png" }, thumbnail: { url: "https://example.com/thumbnail.png" },
    color: 0, timestamp: "2026-11-13T12:00:00.000Z",
    fields: [{ name: "Location", value: "Main hall", inline: true }]
  });
});

test("keeps partial fields and removes empty fields", () => {
  const embed = composeEmbed({
    fields: [{ name: "Name only" }, { value: "Text only", inline: true }, { name: " ", value: "\n" }]
  });
  assert.deepEqual(embed.fields, [
    { name: "Name only", value: "\u200b", inline: false },
    { name: "\u200b", value: "Text only", inline: true }
  ]);
  assert.deepEqual(composeV2Container(embed, false).toJSON().components.map(component =>
    "content" in component ? component.content : undefined
  ), ["**Name only**", "Text only"]);
  assert.throws(() => composeEmbed({ fields: [{}] }), /Add text/);
});

test("rejects invalid or oversized embeds before sending to Discord", () => {
  assert.throws(() => composeEmbed({ color: "#5865f2" }), EmbedInputError);
  assert.throws(() => composeEmbed({ title: "Events", url: "javascript:alert(1)" }), /HTTP or HTTPS/);
  assert.throws(() => composeEmbed({ footerIcon: "https://example.com/icon.png" }), /Enter footer text/);
  assert.throws(() => composeEmbed({ fields: Array(26).fill({ name: "A", value: "B" }) }), /25 fields/);
  assert.throws(() => composeEmbed({ title: "Events", description: "x".repeat(4097) }), /Description/);
  assert.equal(composeEmbed({ title: "Events", description: "x".repeat(4096) }).description?.length, 4096);
  assert.throws(() => composeEmbed({ description: "x".repeat(4096), footerText: "x".repeat(1905) }), /6,000/);
  assert.equal(composeEmbed({ description: "x".repeat(4096), footerText: "x".repeat(1904) }).description?.length, 4096);
});
