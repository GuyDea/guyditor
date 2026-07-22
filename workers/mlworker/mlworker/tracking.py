from __future__ import annotations

from dataclasses import dataclass
from importlib import metadata
from pathlib import Path
from typing import Any, Callable


ProgressCallback = Callable[[float, str], None]


def _required_path(params: dict[str, Any], name: str) -> Path:
    value = params.get(name)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} must be a non-empty string")
    path = Path(value)
    if not path.is_file():
        raise ValueError(f"{name} does not exist: {path}")
    return path


def _sample_every(params: dict[str, Any]) -> int:
    value = params.get("sampleEvery", 3)
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ValueError("sampleEvery must be a positive integer")
    return value


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _box(
    kind: str,
    track_id: str,
    x: float,
    y: float,
    width: float,
    height: float,
    confidence: float,
) -> dict[str, Any]:
    left = _clamp(x)
    top = _clamp(y)
    right = _clamp(x + width)
    bottom = _clamp(y + height)
    return {
        "kind": kind,
        "trackId": track_id,
        "x": left,
        "y": top,
        "w": max(0.000001, right - left),
        "h": max(0.000001, bottom - top),
        "conf": _clamp(confidence),
    }


@dataclass
class _TrackedCenter:
    track_id: str
    x: float
    y: float
    last_frame: int


class _StableIds:
    def __init__(self) -> None:
        self._next: dict[str, int] = {}
        self._tracks: dict[str, list[_TrackedCenter]] = {}

    def assign(
        self,
        kind: str,
        detections: list[tuple[float, float]],
        frame: int,
        maximum_distance: float = 0.20,
    ) -> list[str]:
        active = [
            track
            for track in self._tracks.get(kind, [])
            if frame - track.last_frame <= 30
        ]
        assigned: set[str] = set()
        result: list[str] = []
        for center_x, center_y in detections:
            candidates = sorted(
                (
                    (((center_x - track.x) ** 2 + (center_y - track.y) ** 2) ** 0.5, track)
                    for track in active
                    if track.track_id not in assigned
                ),
                key=lambda candidate: (candidate[0], candidate[1].track_id),
            )
            if candidates and candidates[0][0] <= maximum_distance:
                track = candidates[0][1]
                track.x = center_x
                track.y = center_y
                track.last_frame = frame
            else:
                ordinal = self._next.get(kind, 0) + 1
                self._next[kind] = ordinal
                track = _TrackedCenter(
                    track_id=f"trk_{kind.replace('-', '')}{ordinal:04d}",
                    x=center_x,
                    y=center_y,
                    last_frame=frame,
                )
                active.append(track)
            assigned.add(track.track_id)
            result.append(track.track_id)
        self._tracks[kind] = active
        return result


def _face_boxes(face_detector: Any, rgb: Any) -> list[tuple[float, float, float, float, float]]:
    if face_detector is None:
        return []
    result = face_detector.process(rgb)
    detections = getattr(result, "detections", None) or []
    boxes: list[tuple[float, float, float, float, float]] = []
    for detection in detections:
        relative = detection.location_data.relative_bounding_box
        scores = list(detection.score or [])
        boxes.append(
            (
                float(relative.xmin),
                float(relative.ymin),
                float(relative.width),
                float(relative.height),
                float(scores[0]) if scores else 0.0,
            )
        )
    return boxes


def _body_boxes(pose_detector: Any, rgb: Any) -> list[tuple[float, float, float, float, float]]:
    if pose_detector is None:
        return []
    result = pose_detector.process(rgb)
    landmarks = getattr(getattr(result, "pose_landmarks", None), "landmark", None)
    if not landmarks:
        return []
    visible = [landmark for landmark in landmarks if float(landmark.visibility) >= 0.35]
    if not visible:
        return []
    left = min(float(landmark.x) for landmark in visible)
    top = min(float(landmark.y) for landmark in visible)
    right = max(float(landmark.x) for landmark in visible)
    bottom = max(float(landmark.y) for landmark in visible)
    confidence = sum(float(landmark.visibility) for landmark in visible) / len(visible)
    return [(left, top, right - left, bottom - top, confidence)]


def _generic_object_boxes(
    cv2: Any,
    frame: Any,
) -> list[tuple[float, float, float, float, float]]:
    height, width = frame.shape[:2]
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    _, bright = cv2.threshold(gray, 180, 255, cv2.THRESH_BINARY)
    contours, _ = cv2.findContours(bright, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidates: list[tuple[float, float, float, float, float]] = []
    frame_area = float(width * height)
    for contour in contours:
        area = float(cv2.contourArea(contour))
        if area < max(64.0, frame_area * 0.00005) or area > frame_area * 0.50:
            continue
        x, y, box_width, box_height = cv2.boundingRect(contour)
        perimeter = float(cv2.arcLength(contour, True))
        circularity = 0.0 if perimeter <= 0 else 4.0 * 3.141592653589793 * area / (perimeter * perimeter)
        fill = area / max(1.0, float(box_width * box_height))
        confidence = _clamp(0.45 + 0.35 * circularity + 0.20 * fill)
        candidates.append(
            (
                x / width,
                y / height,
                box_width / width,
                box_height / height,
                confidence,
            )
        )
    candidates.sort(key=lambda candidate: (-(candidate[2] * candidate[3]), candidate[0], candidate[1]))
    return candidates[:8]


def _screen_regions(cv2: Any, frame: Any) -> list[tuple[float, float, float, float, float]]:
    height, width = frame.shape[:2]
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 80, 180)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    frame_area = float(width * height)
    regions: list[tuple[float, float, float, float, float]] = []
    for contour in contours:
        x, y, box_width, box_height = cv2.boundingRect(contour)
        area = float(box_width * box_height)
        if area < frame_area * 0.12 or area > frame_area * 0.92:
            continue
        contour_area = float(cv2.contourArea(contour))
        rectangularity = contour_area / max(1.0, area)
        if rectangularity < 0.55:
            continue
        regions.append(
            (
                x / width,
                y / height,
                box_width / width,
                box_height / height,
                _clamp(0.5 + rectangularity / 2),
            )
        )
    regions.sort(key=lambda candidate: (-(candidate[2] * candidate[3]), candidate[0], candidate[1]))
    return regions[:4]


def track(params: dict[str, Any], progress: ProgressCallback) -> dict[str, Any]:
    import cv2
    import mediapipe as mp

    video_path = _required_path(params, "videoPath")
    sample_every = _sample_every(params)
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise ValueError(f"videoPath could not be decoded: {video_path}")
    frame_count = max(0, int(round(capture.get(cv2.CAP_PROP_FRAME_COUNT))))
    width = max(0, int(round(capture.get(cv2.CAP_PROP_FRAME_WIDTH))))
    height = max(0, int(round(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))))
    fps = float(capture.get(cv2.CAP_PROP_FPS))
    if frame_count <= 0 or width <= 0 or height <= 0:
        capture.release()
        raise ValueError(f"videoPath has invalid stream geometry: {video_path}")

    solutions = getattr(mp, "solutions", None)
    face_detector = None
    pose_detector = None
    if solutions is not None:
        face_detector = solutions.face_detection.FaceDetection(
            model_selection=0,
            min_detection_confidence=0.5,
        )
        pose_detector = solutions.pose.Pose(
            static_image_mode=False,
            model_complexity=0,
            enable_segmentation=False,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5,
        )

    ids = _StableIds()
    samples: list[dict[str, Any]] = []
    frame_index = 0
    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            if frame_index % sample_every == 0:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                detections_by_kind = {
                    "face": _face_boxes(face_detector, rgb),
                    "body": _body_boxes(pose_detector, rgb),
                    "object": _generic_object_boxes(cv2, frame),
                    "screen-region": _screen_regions(cv2, frame),
                }
                boxes: list[dict[str, Any]] = []
                for kind in ("face", "body", "object", "screen-region"):
                    detections = detections_by_kind[kind]
                    centers = [
                        (x + box_width / 2, y + box_height / 2)
                        for x, y, box_width, box_height, _ in detections
                    ]
                    track_ids = ids.assign(kind, centers, frame_index)
                    boxes.extend(
                        _box(kind, track_ids[index], x, y, box_width, box_height, confidence)
                        for index, (x, y, box_width, box_height, confidence) in enumerate(detections)
                    )
                samples.append({"frame": frame_index, "boxes": boxes})
            frame_index += 1
            if frame_index % max(1, sample_every * 5) == 0:
                progress(min(0.99, frame_index / frame_count), "track")
    finally:
        capture.release()
        if face_detector is not None:
            face_detector.close()
        if pose_detector is not None:
            pose_detector.close()

    progress(1.0, "track")
    return {
        "frameCount": frame_index,
        "width": width,
        "height": height,
        "fps": fps,
        "sampleEvery": sample_every,
        "samples": samples,
        "engine": {
            "name": "mediapipe",
            "version": metadata.version("mediapipe"),
        },
    }
