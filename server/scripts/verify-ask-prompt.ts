import "dotenv/config";
import { readFile } from "node:fs/promises";
import { answerQuestion } from "../src/ai.js";
import type { RetrievedDocument } from "../src/retrieval-ranking.js";

const question = "How do I troubleshoot vibration on CNC-042?";
const sopBody = await readFile(new URL("../../seed/SOP-MCH-042.md", import.meta.url), "utf8");
const documents: RetrievedDocument[] = [
  {
    content: sopBody,
    id: "SOP-MCH-042",
    label: "Spindle Vibration Troubleshooting",
    title: "Spindle Vibration Troubleshooting",
    type: "sop",
  },
  {
    content: "Check coolant contamination before replacing the spindle bearing again.",
    id: "CAP-7",
    label: "Coolant contamination before bearing replacement",
    title: "Coolant contamination before bearing replacement",
    type: "capture",
  },
  {
    content: "Inspect the coolant sight glass for cloudiness or suspended debris.",
    id: "CAP-8",
    label: "Coolant sight glass inspection",
    title: "Coolant sight glass inspection",
    type: "capture",
  },
  {
    content:
      "If contamination is present, isolate the machine and replace the coolant before another bearing.",
    id: "CAP-9",
    label: "Contaminated coolant isolation",
    title: "Contaminated coolant isolation",
    type: "capture",
  },
];

const requiredSourceIds = ["CAP-7", "CAP-8", "CAP-9", "SOP-MCH-042"];

for (let run = 1; run <= 3; run += 1) {
  const result = await answerQuestion(question, "CNC-042", documents);
  const opening = result.answer.toLowerCase().slice(0, 160);
  if (!opening.includes("coolant") || !opening.includes("contaminat")) {
    throw new Error(
      `Run ${run}: answer did not lead with coolant contamination. Answer: ${result.answer}`,
    );
  }
  const missingSourceIds = requiredSourceIds.filter(
    (sourceId) => !result.sourceIds.includes(sourceId),
  );
  if (missingSourceIds.length > 0) {
    throw new Error(`Run ${run}: answer omitted ${missingSourceIds.join(", ")}.`);
  }
  console.log(`Run ${run}: PASS (${result.sourceIds.join(", ")})`);
  console.log(result.answer);
}
