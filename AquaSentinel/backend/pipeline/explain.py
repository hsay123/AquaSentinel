"""Deterministic explanation generation from computed values.

Implements the banned-phrase check (constraint 5) and template filling.
Optional LLM polish pass with fallback to raw template.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional
import os

from backend.pipeline.anomaly import AnomalyFlag

# =============================================================================
# Banned phrases — constraint 5: never claim specific contaminant/chemical/health risk
# =============================================================================
BANNED_PHRASES = [
    # Specific contaminants
    "toxic", "poison", "poisonous", "lethal", "deadly",
    "heavy metal", "mercury", "lead", "arsenic", "cadmium", "chromium",
    "pesticide", "herbicide", "fungicide", "insecticide",
    "industrial waste", "chemical spill", "oil spill", "crude oil",
    "sewage", "fecal", "e. coli", "coliform", "pathogen", "bacteria", "virus",
    # Health claims
    "health risk", "health hazard", "unsafe to drink", "drinking water",
    "public health emergency", "carcinogen", "cancer-causing",
    # Specific causation claims
    "caused by", "due to", "result of", "from the", "discharged by",
    "factory", "plant", "facility", "pipe", "outfall",
    # Definitive diagnoses
    "is a", "confirmed", "definitely", "certainly", "proven",
]

# Allowed "consistent with" phrasing
ALLOWED_CONSISTENT = [
    "consistent with",
    "suggestive of",
    "indicative of",
    "characteristic of",
    "typical of",
]


@dataclass
class IndicatorDetail:
    """Detailed indicator values for explanation generation."""
    name: str  # "ndti", "ndci", "fai", "texture_score"
    value: float
    baseline_mean: Optional[float]
    baseline_std: Optional[float]
    z_score: Optional[float]
    direction: str  # "above" or "below"


def check_banned_phrases(text: str) -> list[str]:
    """Check text for banned phrases. Returns list of violations found."""
    violations = []
    text_lower = text.lower()
    for phrase in BANNED_PHRASES:
        if phrase in text_lower:
            violations.append(phrase)
    return violations


def sanitize_explanation(text: str) -> str:
    """Replace banned phrases with safe alternatives."""
    text_lower = text.lower()
    for phrase in BANNED_PHRASES:
        if phrase in text_lower:
            if phrase in ["toxic", "poison", "poisonous"]:
                text = text.replace(phrase, "anomalous")
                text = text.replace(phrase.capitalize(), "Anomalous")
            elif "health" in phrase or "risk" in phrase or "hazard" in phrase:
                text = text.replace(phrase, "optical anomaly")
                text = text.replace(phrase.capitalize(), "Optical anomaly")
            elif phrase in ["caused by", "due to", "result of"]:
                text = text.replace(phrase, "consistent with")
                text = text.replace(phrase.capitalize(), "Consistent with")
            else:
                text = text.replace(phrase, "[removed]")
                text = text.replace(phrase.capitalize(), "[Removed]")
    return text


def build_indicator_sentence(detail: IndicatorDetail) -> str:
    """Build a single indicator sentence from computed values."""
    name_map = {
        "ndti": "Turbidity index (NDTI)",
        "ndci": "Chlorophyll index (NDCI)",
        "fai": "Floating Algae Index (FAI)",
        "texture_score": "Surface texture anomaly",
    }

    display_name = name_map.get(detail.name, detail.name.upper())

    if detail.z_score is not None and detail.baseline_mean is not None:
        sigma = abs(detail.z_score)
        direction_word = "above" if detail.z_score > 0 else "below"
        return (
            f"{display_name} is {sigma:.1f} standard deviations {direction_word} "
            f"the seasonal baseline for this zone"
        )
    elif detail.name == "fai" and detail.value > 0:
        return f"{display_name} is positive"
    elif detail.name == "texture_score" and detail.z_score is not None:
        sigma = abs(detail.z_score)
        direction_word = "above" if detail.z_score > 0 else "below"
        return (
            f"Surface texture is {sigma:.1f} standard deviations {direction_word} "
            f"the historical norm for this zone"
        )
    else:
        return f"{display_name} shows an anomalous value of {detail.value:.3f}"


def build_consistency_phrase(indicators: list[IndicatorDetail]) -> str:
    """Build the 'consistent with' phrase based on which indicators flagged."""
    names = [i.name for i in indicators]

    if "ndci" in names and "fai" in names:
        return "consistent with algal bloom onset"
    elif "ndci" in names:
        return "consistent with elevated chlorophyll concentration"
    elif "fai" in names:
        return "consistent with floating algae or surface scum"
    elif "ndti" in names:
        return "consistent with increased turbidity or suspended sediment"
    elif "texture_score" in names:
        return "consistent with a surface disturbance such as foam, sheen, or discharge plume"
    else:
        return "consistent with an optically observable anomaly"


def generate_explanation(flag: AnomalyFlag, indicators_detail: list[dict]) -> str:
    """Generate deterministic explanation from AnomalyFlag and indicator details.

    This is the core explainability function — pure template filling from
    computed numbers. No LLM required for MVP.

    Args:
        flag: AnomalyFlag with z-scores and fusion result
        indicators_detail: List of dicts with name, value, baseline_mean, baseline_std, z_score

    Returns:
        Explanation string (guaranteed free of banned phrases)
    """
    # Convert to IndicatorDetail objects
    details = []
    for d in indicators_detail:
        z = d.get("z_score")
        direction = "above" if z is not None and z > 0 else "below"
        details.append(IndicatorDetail(
            name=d["name"],
            value=d["value"],
            baseline_mean=d.get("baseline_mean"),
            baseline_std=d.get("baseline_std"),
            z_score=z,
            direction=direction,
        ))

    # Build indicator sentences
    indicator_sentences = []
    for detail in details:
        if detail.z_score is not None and abs(detail.z_score) > 0.5:  # Only mention significant ones
            indicator_sentences.append(build_indicator_sentence(detail))

    # Build consistency phrase
    consistency = build_consistency_phrase(details)

    # Zone/sector reference
    zone_ref = f"in zone {flag.zone_id}"

    # Confidence wording
    if flag.confidence == "high":
        confidence_word = "High confidence (statistical detection)"
    elif flag.confidence == "needs_review":
        confidence_word = "Needs review (pattern detection only)"
    else:
        confidence_word = "No significant anomaly detected"

    # Combine into template
    if flag.confidence == "none":
        template = f"No significant anomaly detected {zone_ref} on {flag.date}."
    elif flag.statistical_flag and flag.if_flag:
        template = (
            f"{', '.join(indicator_sentences)} {zone_ref} on {flag.date}, "
            f"{consistency}. {confidence_word}."
        )
    elif flag.statistical_flag:
        template = (
            f"{', '.join(indicator_sentences)} {zone_ref} on {flag.date}, "
            f"{consistency}. {confidence_word}."
        )
    else:  # ML-only flag
        template = (
            f"A novel multivariate pattern was detected {zone_ref} on {flag.date} "
            f"but no single indicator exceeded its statistical threshold. "
            f"{consistency}. {confidence_word}."
        )

    # Sanity check: enforce banned phrase constraint
    violations = check_banned_phrases(template)
    if violations:
        template = sanitize_explanation(template)

    return template


def llm_polish_explanation(
    raw_explanation: str,
    groq_api_key: Optional[str] = None,
    model: str = "llama-3.3-70b-versatile",
) -> tuple[str, bool]:
    """Optional LLM polish pass for fluency.

    Must not add unsupported facts. Falls back to raw template on failure.

    Returns:
        (polished_text, generated_flag) where generated_flag=True if LLM was used
    """
    if not groq_api_key:
        groq_api_key = os.environ.get("GROQ_API_KEY")

    if not groq_api_key:
        return raw_explanation, False

    try:
        from groq import Groq
        client = Groq(api_key=groq_api_key)

        prompt = f"""Rewrite the following water quality alert explanation for clarity and fluency.
DO NOT add any facts, claims, or interpretations not present in the original.
DO NOT use any banned phrases: toxic, poison, health risk, caused by, confirmed, etc.
Only improve sentence flow and readability.

Original: {raw_explanation}

Rewritten:"""

        response = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=200,
            reasoning_effort="none",
        )

        polished = response.choices[0].message.content.strip()

        # Verify no new facts added (simple check: polished shouldn't be much longer)
        if len(polished) > len(raw_explanation) * 1.5:
            return raw_explanation, False

        # Re-check banned phrases
        if check_banned_phrases(polished):
            return raw_explanation, False

        return polished, True

    except Exception:
        return raw_explanation, False