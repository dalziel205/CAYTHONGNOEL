import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

export async function initMediaPipe({ videoEl, canvasEl, processResultCallback }) {
    const webcamCanvas = canvasEl;
    const webcamCtx = webcamCanvas.getContext('2d');
    webcamCanvas.width = 160; webcamCanvas.height = 120;

    const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
    );
    const handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
            modelAssetPath: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
            delegate: "GPU"
        },
        runningMode: "VIDEO",
        numHands: 2
    });

    if (navigator.mediaDevices?.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        videoEl.srcObject = stream;
        videoEl.addEventListener("loadeddata", predictWebcam);
    }

    let lastVideoTime = -1;
    async function predictWebcam() {
        if (videoEl.currentTime !== lastVideoTime) {
            lastVideoTime = videoEl.currentTime;
            try { webcamCtx.drawImage(videoEl, 0, 0, webcamCanvas.width, webcamCanvas.height); } catch (e) {}
            if (handLandmarker) {
                const result = handLandmarker.detectForVideo(videoEl, performance.now());
                processResultCallback(result);
            }
        }
        requestAnimationFrame(predictWebcam);
    }

    return { handLandmarker };
}