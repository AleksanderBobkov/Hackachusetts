"""Scripted demo event stream for ``/ws?mock=1`` so the UI can be built in parallel.

Covers every event type in architecture §6, in the order the real backend emits them.
All content is synthetic. Every event is built from the pydantic models, so the stream
cannot drift from the contract.
"""

from __future__ import annotations

from collections.abc import Iterator

from pydantic import BaseModel

from companion.events import (
    AnswerEvent,
    ErrorEvent,
    PhotoEvent,
    PlaybackEvent,
    ProposalEvent,
    StateEvent,
    TranscriptEvent,
    TranslationEvent,
)

Step = tuple[float, BaseModel]  # (delay in seconds before sending, event)

STORY_A = (
    "This is my mother Evelyn with her brother Arthur at Cape Ann. It was summer, "
    "but I'm not certain which year. She likes being asked about her garden. "
    "Please don't use my voice as hers."
)


def _span(phrase: str, text: str = STORY_A) -> dict[str, int]:
    start = text.index(phrase)
    return {"start": start, "end": start + len(phrase)}


def _translate_turn(turn: int, speaker: str, src: str, dst: str, said: str, means: str) -> list[Step]:
    s = dict(mode="translate", speaker=speaker, turn_id=turn)
    return [
        (1.0, StateEvent(state="listening", **s)),
        (2.5, StateEvent(state="transcribing", **s)),
        (0.8, TranscriptEvent(turn_id=turn, speaker=speaker, language=src, text=said)),
        (0.1, StateEvent(state="translating", **s)),
        (0.6, TranslationEvent(turn_id=turn, source=src, target=dst, text=means)),
        (0.1, StateEvent(state="speaking", **s)),
        (0.2, PlaybackEvent(turn_id=turn, status="started")),
        (2.5, PlaybackEvent(turn_id=turn, status="finished")),
        (0.1, StateEvent(state="idle", mode="translate")),
    ]


def demo_script() -> list[Step]:
    steps: list[Step] = [(0.0, StateEvent(state="idle", mode="translate"))]

    # 1. Translate: grandmother (pl) → grandchild (en), then the reply.
    steps += _translate_turn(
        1, "a", "pl", "en",
        "Cześć kochanie, jak się masz? Tęskniłam za tobą.",
        "Hi sweetheart, how are you? I missed you.",
    )
    steps += _translate_turn(
        2, "b", "en", "pl",
        "I'm good, Babcia! I brought photos from the summer.",
        "Dobrze, Babciu! Przyniosłam zdjęcia z lata.",
    )

    # 2. Companion: grounded answer, then MUTE during playback.
    c = dict(mode="companion", speaker="resident")
    steps += [
        (1.5, StateEvent(state="idle", mode="companion")),
        (0.2, PhotoEvent(photo_id="photo-demo-01", url="/photos/photo-demo-01.jpg")),
        (1.5, StateEvent(state="listening", turn_id=3, **c)),
        (2.0, StateEvent(state="transcribing", turn_id=3, **c)),
        (0.7, TranscriptEvent(turn_id=3, speaker="resident", language="pl",
                              text="Kto jest na tym zdjęciu?")),
        (0.1, StateEvent(state="thinking", turn_id=3, **c)),
        (1.2, AnswerEvent(turn_id=3, language="pl",
                          text="Według notatek rodzinnych to Pani brat Arthur, na Cape Ann. "
                               "Pamięta Pani tamto lato?",
                          claim_ids=["claim-demo-01", "claim-demo-02"])),
        (0.1, StateEvent(state="speaking", turn_id=3, **c)),
        (0.2, PlaybackEvent(turn_id=3, status="started")),
        (1.5, PlaybackEvent(turn_id=3, status="stopped")),  # MUTE pressed
        (0.0, StateEvent(state="muted", mode="companion")),
        # Absent fact → says it isn't in the family notes.
        (1.5, StateEvent(state="listening", turn_id=4, **c)),
        (2.0, StateEvent(state="transcribing", turn_id=4, **c)),
        (0.7, TranscriptEvent(turn_id=4, speaker="resident", language="pl",
                              text="W którym roku to było?")),
        (0.1, StateEvent(state="thinking", turn_id=4, **c)),
        (1.2, AnswerEvent(turn_id=4, language="pl",
                          text="Tego nie ma w notatkach rodzinnych — rok nie jest znany.",
                          claim_ids=[])),
        (0.1, StateEvent(state="speaking", turn_id=4, **c)),
        (0.2, PlaybackEvent(turn_id=4, status="started")),
        (2.0, PlaybackEvent(turn_id=4, status="finished")),
        (0.1, StateEvent(state="idle", mode="companion")),
        # Unintelligible speech → visible error, no fabricated answer.
        (1.5, StateEvent(state="listening", turn_id=5, **c)),
        (1.5, StateEvent(state="transcribing", turn_id=5, **c)),
        (0.6, ErrorEvent(turn_id=5, code="stt_failed",
                         message="I didn't catch that — press TALK to try again.")),
        (0.0, StateEvent(state="error", mode="companion")),
    ]

    # 3. Contribute: family story → review card.
    k = dict(mode="contribute", speaker="contributor")
    steps += [
        (2.0, StateEvent(state="idle", mode="contribute")),
        (1.0, StateEvent(state="listening", turn_id=6, **k)),
        (4.0, StateEvent(state="transcribing", turn_id=6, **k)),
        (0.9, TranscriptEvent(
            turn_id=6, speaker="contributor", language="en",
            text=STORY_A)),
        (0.1, StateEvent(state="thinking", turn_id=6, **k)),
        (2.0, ProposalEvent(
            proposal_id="prop-demo-01",
            claims=[
                {"claim_id": "pc-1", "action": "create", "kind": "relationship",
                 "text": "The family note identifies Arthur as Evelyn's brother in photo-demo-01.",
                 "attributed_to": "contributor-demo-01", "locator": _span('her brother Arthur'),
                 "evidence": 'her brother Arthur', "confidence": 0.92, "needs_review": False},
                {"claim_id": "pc-2", "action": "create", "kind": "place",
                 "text": "photo-demo-01 was taken at Cape Ann.",
                 "attributed_to": "contributor-demo-01", "locator": _span('at Cape Ann'),
                 "evidence": 'at Cape Ann', "confidence": 0.9, "needs_review": False},
                {"claim_id": "pc-3", "action": "create", "kind": "preference",
                 "text": "Evelyn likes being asked about her garden (reported by contributor).",
                 "attributed_to": "contributor-demo-01", "locator": _span('She likes being asked about her garden'),
                 "evidence": 'She likes being asked about her garden',
                 "confidence": 0.85, "needs_review": False},
                {"claim_id": "pc-4", "action": "create", "kind": "prohibited_use",
                 "text": "Do not use the contributor's voice as Evelyn's voice.",
                 "attributed_to": "contributor-demo-01", "locator": _span("Please don't use my voice as hers"),
                 "evidence": "Please don't use my voice as hers",
                 "confidence": 0.95, "needs_review": False},
            ],
            unknowns=[{"field": "photo_year", "photo_id": "photo-demo-01",
                       "evidence": "I'm not certain which year",
                       "locator": _span("I'm not certain which year")}],
        )),
        (0.1, StateEvent(state="idle", mode="contribute")),
    ]
    return steps


def iter_script(loop: bool = False) -> Iterator[Step]:
    while True:
        yield from demo_script()
        if not loop:
            return
