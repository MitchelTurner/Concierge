import test from "node:test";
import assert from "node:assert/strict";
import type { ProjectTask, ProjectWithTasks } from "./db.js";
import { allocateDay, planTimebox, scoreProject } from "./scoring.js";

function project(overrides: Partial<ProjectWithTasks>): ProjectWithTasks {
  return {
    id: 1,
    user_id: 1,
    name: "Project",
    type: "fast",
    client: null,
    revenue_potential: 3,
    confidence: 3,
    time_to_cash: 3,
    effort_remaining: 8,
    status: "active",
    next_action: "Do the next thing",
    deadline: null,
    notes: null,
    last_progress_at: new Date("2026-06-28T00:00:00.000Z").toISOString(),
    created_at: new Date("2026-06-01T00:00:00.000Z").toISOString(),
    updated_at: new Date("2026-06-01T00:00:00.000Z").toISOString(),
    tasks: [],
    ...overrides,
  };
}

test("scoreProject favors faster cash and lower effort", () => {
  const fast = project({ revenue_potential: 5, confidence: 4, time_to_cash: 1, effort_remaining: 4 });
  const slow = project({ revenue_potential: 5, confidence: 4, time_to_cash: 5, effort_remaining: 12 });
  assert.ok(scoreProject(fast) > scoreProject(slow));
});

test("allocateDay picks fast primary and passive secondary", () => {
  const projects = [
    project({
      id: 1,
      name: "Passive blog",
      type: "passive",
      revenue_potential: 5,
      confidence: 4,
      time_to_cash: 4,
      effort_remaining: 6,
      next_action: "Draft the article",
    }),
    project({
      id: 2,
      name: "Client landing page",
      type: "fast",
      revenue_potential: 4,
      confidence: 5,
      time_to_cash: 1,
      effort_remaining: 3,
      next_action: "Ship the pricing page",
    }),
  ];

  const allocation = allocateDay(projects);
  assert.equal(allocation.primary?.project.id, 2);
  assert.equal(allocation.secondary?.project.id, 1);
});

test("allocateDay does not promote passive work when no fast project is ready", () => {
  const projects = [
    project({
      id: 3,
      type: "passive",
      name: "Passive SEO site",
      next_action: "Outline the next post",
    }),
  ];

  const allocation = allocateDay(projects);
  assert.equal(allocation.primary, null);
  assert.equal(allocation.secondary?.project.id, 3);
});

function task(id: number, projectId: number, title: string, done = false): ProjectTask {
  return {
    id,
    user_id: 1,
    project_id: projectId,
    title,
    done,
    sort_order: id,
    created_at: new Date("2026-06-01T00:00:00.000Z").toISOString(),
    updated_at: new Date("2026-06-01T00:00:00.000Z").toISOString(),
  };
}

test("planTimebox fills a short block with one income task", () => {
  const projects = [
    project({
      id: 1,
      type: "fast",
      name: "Client site",
      tasks: [task(11, 1, "Send invoice"), task(12, 1, "Fix header")],
    }),
    project({ id: 2, type: "passive", name: "Blog", next_action: "Draft post" }),
  ];

  const plan = planTimebox(projects, 30);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0]?.action, "Send invoice");
  assert.equal(plan.items[0]?.project.id, 1);
});

test("planTimebox adds passive work only when an hour or more is free", () => {
  const projects = [
    project({ id: 1, type: "fast", name: "Client site", tasks: [task(11, 1, "Send invoice")] }),
    project({ id: 2, type: "passive", name: "Blog", next_action: "Draft post" }),
  ];

  const short = planTimebox(projects, 45);
  assert.deepEqual(short.items.map((i) => i.action), ["Send invoice"]);

  const long = planTimebox(projects, 90);
  assert.deepEqual(long.items.map((i) => i.action), ["Send invoice", "Draft post"]);
});

test("planTimebox pulls several tasks from the top fast project for big blocks", () => {
  const projects = [
    project({
      id: 1,
      type: "fast",
      name: "Client site",
      tasks: [task(11, 1, "Send invoice"), task(12, 1, "Fix header"), task(13, 1, "Deploy")],
    }),
  ];

  const plan = planTimebox(projects, 90);
  assert.deepEqual(plan.items.map((i) => i.action), ["Send invoice", "Fix header", "Deploy"]);
});

test("planTimebox falls back to passive work when nothing fast is ready", () => {
  const projects = [
    project({ id: 1, type: "fast", name: "Idle fast", status: "idea" }),
    project({ id: 2, type: "passive", name: "Blog", next_action: "Draft post" }),
  ];

  const plan = planTimebox(projects, 30);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0]?.project.id, 2);
});

test("planTimebox skips done tasks", () => {
  const projects = [
    project({
      id: 1,
      type: "fast",
      name: "Client site",
      next_action: null,
      tasks: [task(11, 1, "Send invoice", true), task(12, 1, "Fix header")],
    }),
  ];

  const plan = planTimebox(projects, 30);
  assert.deepEqual(plan.items.map((i) => i.action), ["Fix header"]);
});

test("allocateDay surfaces deadline warnings", () => {
  const soon = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const later = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  const projects = [
    project({ id: 4, name: "Urgent client work", deadline: soon }),
    project({ id: 5, name: "Later work", deadline: later }),
  ];

  const allocation = allocateDay(projects);
  assert.deepEqual(allocation.deadlineWarnings.map((p) => p.id), [4]);
});