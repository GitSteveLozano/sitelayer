// ai-app.jsx — assemble the AI Layer canvas

const PHONE_W = 280;
const PHONE_H = 580;
const DOC_W = 420;
const DOC_H = 580;

function App() {
  return (
    <DesignCanvas>
      <DCSection id="00-cover" title="AI Layer" subtitle="Visual language doc · iteration 4 · before any new screen ships">
        <DCArtboard id="cover" label="Cover" width={DOC_W} height={DOC_H}><ArtCover/></DCArtboard>
      </DCSection>

      <DCSection id="01-three-layers" title="§01 · Three layers, three treatments" subtitle="Lock the visual signature so AI reads consistently across every surface.">
        <DCArtboard id="three-layers" label="Layer taxonomy" width={DOC_W} height={DOC_H}><ArtThreeLayers/></DCArtboard>
      </DCSection>

      <DCSection id="02-language" title="§02 · The mark, the words, the gestures" subtitle="Spark icon · source attribution · reject affordances · color tokens.">
        <DCArtboard id="spark-states" label="Spark · confidence states" width={DOC_W} height={DOC_H}><ArtSparkStates/></DCArtboard>
        <DCArtboard id="source-attr" label="Source attribution" width={DOC_W} height={DOC_H}><ArtSourceAttr/></DCArtboard>
        <DCArtboard id="reject" label="Reject · edit affordances" width={DOC_W} height={DOC_H}><ArtRejectAffordance/></DCArtboard>
        <DCArtboard id="swatches" label="Color tokens" width={DOC_W} height={DOC_H}><ArtSwatches/></DCArtboard>
      </DCSection>

      <DCSection id="03-calm" title="§03 · Calm by default" subtitle="Same screen, two states. AI surfaces only when there's signal.">
        <DCArtboard id="calm-dormant" label="Dormant · nothing to see" width={PHONE_W} height={PHONE_H}><ArtCalmDormant/></DCArtboard>
        <DCArtboard id="calm-signal" label="Signal present · AI earned the surface" width={PHONE_W} height={PHONE_H}><ArtCalmSignal/></DCArtboard>
      </DCSection>

      <DCSection id="04-states" title="§04 · Empty · learning · confident" subtitle="Features that need data can't fail to a confusing blank.">
        <DCArtboard id="state-empty" label="Empty · zero data" width={PHONE_W} height={PHONE_H}><ArtStateEmpty/></DCArtboard>
        <DCArtboard id="state-learning" label="Learning · low confidence" width={PHONE_W} height={PHONE_H}><ArtStateLearning/></DCArtboard>
        <DCArtboard id="state-confident" label="Confident · pattern observed" width={PHONE_W} height={PHONE_H}><ArtStateConfident/></DCArtboard>
      </DCSection>

      <DCSection id="05-keystone" title="§05 · Bid accuracy — the keystone" subtitle="The feature that compounds. The data moat made visible. Two variants of the inline card; closeout + portfolio views.">
        <DCArtboard id="bid-a" label="A · Card above the table" width={PHONE_W} height={PHONE_H}><ArtBidAccuracyA/></DCArtboard>
        <DCArtboard id="bid-b" label="B · Inline on the affected line" width={PHONE_W} height={PHONE_H}><ArtBidAccuracyB/></DCArtboard>
        <DCArtboard id="bid-closeout" label="Closeout · bid vs actual" width={PHONE_W} height={PHONE_H}><ArtBidCloseout/></DCArtboard>
        <DCArtboard id="bid-portfolio" label="Portfolio · estimating insights" width={PHONE_W} height={PHONE_H}><ArtPortfolioInsights/></DCArtboard>
      </DCSection>

      <DCSection id="06-agent" title="§06 · Takeoff-to-bid agent — the demo" subtitle="The screen customers and investors will remember. Two ways to express the same review pattern.">
        <DCArtboard id="agent-a" label="A · Canvas-first" width={PHONE_W} height={PHONE_H}><ArtAgentTakeoffA/></DCArtboard>
        <DCArtboard id="agent-b" label="B · Queue-first" width={PHONE_W} height={PHONE_H}><ArtAgentTakeoffB/></DCArtboard>
        <DCArtboard id="agent-empty" label="Onboarding · drop a plan" width={PHONE_W} height={PHONE_H}><ArtAgentEmpty/></DCArtboard>
      </DCSection>

      <DCSection id="07-why" title="§07 · Why this? overlay" subtitle="DecisionOverlay adapted for AI explanations. Same shape; AI-flavored content.">
        <DCArtboard id="why-this" label="Why this card?" width={PHONE_W} height={PHONE_H}><ArtWhyThis/></DCArtboard>
      </DCSection>

      <DCSection id="08-not-building" title="§08 · What we're NOT building" subtitle="The traps. Every item here will be proposed at some point. Hold the line.">
        <DCArtboard id="anti-list" label="The anti-list" width={DOC_W} height={DOC_H}><ArtAntiList/></DCArtboard>
        <DCArtboard id="rj-chat" label="No chatbot" width={PHONE_W} height={PHONE_H}><ArtRejectChat/></DCArtboard>
        <DCArtboard id="rj-aitab" label="No AI tab" width={PHONE_W} height={PHONE_H}><ArtRejectAITab/></DCArtboard>
        <DCArtboard id="rj-vanity" label="No vanity metrics" width={PHONE_W} height={PHONE_H}><ArtRejectVanity/></DCArtboard>
        <DCArtboard id="rj-order" label="No auto-orders" width={PHONE_W} height={PHONE_H}><ArtRejectAutoOrder/></DCArtboard>
        <DCArtboard id="rj-conf" label="No % confidence" width={PHONE_W} height={PHONE_H}><ArtRejectConfidence/></DCArtboard>
        <DCArtboard id="rj-autolog" label="No agent-only daily log" width={PHONE_W} height={PHONE_H}><ArtRejectAutoLog/></DCArtboard>
      </DCSection>
    </DesignCanvas>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
