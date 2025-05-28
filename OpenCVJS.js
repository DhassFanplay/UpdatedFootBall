let detector = null;
let selectedDeviceId = null;
let unityInstance = null;
let video = null;
let canvas = null;
let ctx = null;
let firstFrameSent = false;

let frameLoopId = null;
let poseLoopId = null;

const MIN_SCORE = 0.2;
const SMOOTHING_ALPHA = 0.6;
let lastFoot = null;

// Step 1: Send available cameras to Unity
async function listCameras() {
    if (!navigator.mediaDevices?.enumerateDevices) {
        console.error("MediaDevices API not supported.");
        return;
    }

    try {
        await navigator.mediaDevices.getUserMedia({ video: true });
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoInputs = devices.filter(d => d.kind === 'videoinput');

        const options = videoInputs.map(d => ({
            label: d.label || `Camera ${d.deviceId?.substring(0, 4)}`,
            deviceId: d.deviceId || ""
        }));

        console.log("Available cameras:", options);

        if (unityInstance) {
            unityInstance.SendMessage('CameraManager', 'OnReceiveCameraList', JSON.stringify(options));
        }
    } catch (err) {
        console.error("Error accessing camera list:", err);
    }
}

// Step 2: Called by Unity to start tracking
async function StartPoseTracking(deviceId) {
    console.log("Switching to device:", deviceId);
    selectedDeviceId = deviceId;
    firstFrameSent = false;

    cancelLoops();
    await setupCamera(deviceId);
    startFrameLoop();

    if (!detector) {
        await loadDetector();
    }

    startPoseDetectionLoop();
}

// Step 3: Setup camera and canvas
async function setupCamera(deviceId) {
    try {
        if (video?.srcObject) {
            video.srcObject.getTracks().forEach(track => track.stop());
            video.srcObject = null;
        }

        if (!video) {
            video = document.createElement("video");
            video.setAttribute("autoplay", "");
            video.setAttribute("playsinline", "");
            video.style.display = "none";
            document.body.appendChild(video);
        }

        const stream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: deviceId } },
            audio: false
        });

        video.srcObject = stream;

        await new Promise(resolve => {
            video.onloadedmetadata = () => {
                video.play().then(resolve).catch(resolve);
            };
        });

        if (!canvas) {
            canvas = document.createElement("canvas");
            canvas.style.display = "none";
            document.body.appendChild(canvas);
            ctx = canvas.getContext("2d");
        }

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
    } catch (error) {
        console.error("Error setting up camera:", error);
    }
}

// Step 4: Load MoveNet detector
async function loadDetector() {
    try {
        await tf.setBackend("webgl");
        await tf.ready();

        detector = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, {
            modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING
        });

        console.log("MoveNet detector loaded");
    } catch (error) {
        console.error("Error loading pose detector:", error);
    }
}

// Step 5a: Send video frame to Unity
function startFrameLoop() {
    function sendFrame() {
        if (!video || video.readyState < 2) {
            frameLoopId = requestAnimationFrame(sendFrame);
            return;
        }

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const base64 = canvas.toDataURL("image/jpeg");

        if (unityInstance) {
            unityInstance.SendMessage("CameraManager", "OnReceiveVideoFrame", base64);
            if (!firstFrameSent) {
                unityInstance.SendMessage("CameraManager", "OnCameraReady");
                firstFrameSent = true;
            }
        }

        frameLoopId = requestAnimationFrame(sendFrame);
    }

    sendFrame();
}

// Step 5b: Estimate poses and send foot position to Unity
function startPoseDetectionLoop() {
    async function detect() {
        if (!detector || !video || video.readyState < 2) {
            poseLoopId = requestAnimationFrame(detect);
            return;
        }

        if (unityInstance) {
            unityInstance.SendMessage("CameraManager", "AILoaded");
        }

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        try {
            const poses = await detector.estimatePoses(canvas);
            if (poses.length > 0) {
                const keypoints = poses[0].keypoints;
                const leftAnkle = keypoints[15];
                const rightAnkle = keypoints[16];

                const foot = (leftAnkle?.score ?? 0) > (rightAnkle?.score ?? 0) ? leftAnkle : rightAnkle;

                if (foot && foot.score > MIN_SCORE) {
                    const smoothed = lastFoot
                        ? {
                            x: SMOOTHING_ALPHA * lastFoot.x + (1 - SMOOTHING_ALPHA) * foot.x,
                            y: SMOOTHING_ALPHA * lastFoot.y + (1 - SMOOTHING_ALPHA) * foot.y
                        }
                        : { x: foot.x, y: foot.y };

                    lastFoot = smoothed;

                    const normalized = {
                        x: smoothed.x / canvas.width,
                        y: smoothed.y / canvas.height
                    };

                    if (unityInstance) {
                        unityInstance.SendMessage("FootCube", "OnReceiveFootPosition", JSON.stringify(normalized));
                    }
                }
            }
        } catch (err) {
            console.error("Pose detection error:", err);
        }

        if ('requestVideoFrameCallback' in video) {
            video.requestVideoFrameCallback(() => detect());
        } else {
            poseLoopId = requestAnimationFrame(detect);
        }
    }

    detect();
}

// Cancel any active loops
function cancelLoops() {
    if (frameLoopId) cancelAnimationFrame(frameLoopId);
    if (poseLoopId) cancelAnimationFrame(poseLoopId);
    frameLoopId = null;
    poseLoopId = null;
}

// Unity registration
function RegisterUnityInstance(instance) {
    unityInstance = instance;
    listCameras();
}

// Expose to global
window.RegisterUnityInstance = RegisterUnityInstance;
window.StartPoseTracking = StartPoseTracking;
