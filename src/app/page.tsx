import { AllergyBridgeApp } from "@/components/AllergyBridgeApp";

export default function Home() {
  // Phase A: production UI is card_only, including when server env is misconfigured.
  // Enabling the production UI for Gemini requires the separately approved Phase B PR.
  return <AllergyBridgeApp analysisAvailable={
    process.env.NODE_ENV !== "production" && process.env.MOCK_GEMINI === "true"
  } />;
}
