import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'; 
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'; 
import { initMediaPipe } from './mediapipe.js';
import { initPhotoUpload } from './photos.js';

// --- CONFIGURATION ---
const CONFIG = {
    colors: {
        bg: 0x000000, 
        champagneGold: 0xffd966, 
        deepGreen: 0x03180a,     
        accentRed: 0x990000,     
    },
    particles: {
        count: 1500,     
        dustCount: 2500, 
        treeHeight: 24,  
        treeRadius: 8    
    },
    camera: {
        z: 50 
    }
};

const STATE = {
    mode: 'TREE', 
    focusIndex: -1, 
    focusTarget: null,
    hand: { detected: false, x: 0, y: 0 },
    rotation: { x: 0, y: 0 } 
};

let scene, camera, renderer, composer;
let mainGroup; 
let clock = new THREE.Clock();
let particleSystem = []; 
let photoMeshGroup = new THREE.Group();
let handLandmarker, video, webcamCanvas, webcamCtx;
let caneTexture; 
let topStar;
let loveMesh;

class Particle {
    constructor(mesh, type, isDust = false) {
        this.mesh = mesh;
        this.type = type;
        this.isDust = isDust;
        
        this.posTree = new THREE.Vector3();
        this.posScatter = new THREE.Vector3();
        this.posHeart = new THREE.Vector3();
        this.baseScale = mesh.scale.x; 

        const speedMult = (type === 'PHOTO') ? 0.3 : 2.0;

        this.spinSpeed = new THREE.Vector3(
            (Math.random() - 0.5) * speedMult,
            (Math.random() - 0.5) * speedMult,
            (Math.random() - 0.5) * speedMult
        );

        this.calculatePositions();
    }

    calculatePositions() {
        const h = CONFIG.particles.treeHeight;
        const halfH = h / 2;
        let t = Math.random(); 
        t = Math.pow(t, 0.8); 
        const y = (t * h) - halfH;
        let rMax = CONFIG.particles.treeRadius * (1.0 - t); 
        if (rMax < 0.5) rMax = 0.5;
        const angle = t * 50 * Math.PI + Math.random() * Math.PI; 
        const r = rMax * (0.8 + Math.random() * 0.4); 
        this.posTree.set(Math.cos(angle) * r, y, Math.sin(angle) * r);

        let rScatter = this.isDust ? (12 + Math.random()*20) : (8 + Math.random()*12);
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        this.posScatter.set(
            rScatter * Math.sin(phi) * Math.cos(theta),
            rScatter * Math.sin(phi) * Math.sin(theta),
            rScatter * Math.cos(phi)
        );

        // HEART: soft filled heart shape (parametric)
        const tHeart = Math.random() * Math.PI * 2;
        let hx = 16 * Math.pow(Math.sin(tHeart), 3);
        let hy = 13 * Math.cos(tHeart) - 5 * Math.cos(2*tHeart) - 2 * Math.cos(3*tHeart) - Math.cos(4*tHeart);
        const rFill = Math.pow(Math.random(), 0.3);
        hx *= rFill; hy *= rFill;
        let hz = (Math.random() - 0.5) * 8 * rFill;
        const noise = 1.0;
        hx += (Math.random() - 0.5) * noise;
        hy += (Math.random() - 0.5) * noise;
        hz += (Math.random() - 0.5) * noise;
        const scaleH = 0.25 * CONFIG.particles.treeHeight;
        this.posHeart.set(hx * scaleH, hy * scaleH + 2.0, hz);
    }

    update(dt, mode, focusTargetMesh) {
        let target = this.posTree;
        
        if (mode === 'SCATTER') target = this.posScatter;
        else if (mode === 'HEART') target = this.posHeart;
        else if (mode === 'FOCUS') {
            if (this.mesh === focusTargetMesh) {
                const desiredWorldPos = new THREE.Vector3(0, 2, 35);
                const invMatrix = new THREE.Matrix4().copy(mainGroup.matrixWorld).invert();
                target = desiredWorldPos.applyMatrix4(invMatrix);
            } else {
                target = this.posScatter;
            }
        }

        const lerpSpeed = (mode === 'FOCUS' && this.mesh === focusTargetMesh) ? 5.0 : 2.0; 
        this.mesh.position.lerp(target, lerpSpeed * dt);

        if (mode === 'SCATTER') {
            this.mesh.rotation.x += this.spinSpeed.x * dt;
            this.mesh.rotation.y += this.spinSpeed.y * dt;
            this.mesh.rotation.z += this.spinSpeed.z * dt; 
        } else if (mode === 'TREE') {
            this.mesh.rotation.x = THREE.MathUtils.lerp(this.mesh.rotation.x, 0, dt);
            this.mesh.rotation.z = THREE.MathUtils.lerp(this.mesh.rotation.z, 0, dt);
            this.mesh.rotation.y += 0.5 * dt; 
        } else if (mode === 'HEART') {
            // ease to a neutral orientation for heart shape
            this.mesh.rotation.x = THREE.MathUtils.lerp(this.mesh.rotation.x, 0, dt*3);
            this.mesh.rotation.y = THREE.MathUtils.lerp(this.mesh.rotation.y, 0, dt*3);
            this.mesh.rotation.z = THREE.MathUtils.lerp(this.mesh.rotation.z, 0, dt*3);
        }
        
        if (mode === 'FOCUS' && this.mesh === focusTargetMesh) {
            this.mesh.lookAt(camera.position); 
        }

        if (this.mesh.userData.isBlink && this.mesh.material && ('emissiveIntensity' in this.mesh.material || 'emissive' in this.mesh.material)) {
            const phase = this.mesh.userData.blinkPhase || 0;
            const speed = this.mesh.userData.blinkSpeed || 2.0;
            const b = 0.5 + 0.5 * Math.sin(clock.elapsedTime * speed + phase);
            const base = this.mesh.userData.baseEmissive !== undefined ? this.mesh.userData.baseEmissive : 0.3;
            const amp = this.mesh.userData.blinkAmp !== undefined ? this.mesh.userData.blinkAmp : 1.5;
            if (this.mesh.userData.blinkColor) {
                try { this.mesh.material.emissive = new THREE.Color(this.mesh.userData.blinkColor); } catch (e) {}
            }
            const intensity = Math.max(0, base + amp * b);
            try {
                if ('emissiveIntensity' in this.mesh.material) {
                    this.mesh.material.emissiveIntensity = intensity;
                } else if ('emissive' in this.mesh.material) {
                    const c = this.mesh.material.emissive.clone().multiplyScalar(intensity);
                    this.mesh.material.emissive.copy(c);
                }
            } catch (e) {}
        }

        let s = this.baseScale;
        if (this.isDust) {
            s = this.baseScale * (0.8 + 0.4 * Math.sin(clock.elapsedTime * 4 + this.mesh.id));
            if (mode === 'TREE') s = 0; 
        } else if (mode === 'SCATTER' && this.type === 'PHOTO') {
            s = this.baseScale * 2.5; 
        } else if (mode === 'FOCUS') {
            if (this.mesh === focusTargetMesh) s = 4.5; 
            else s = this.baseScale * 0.8; 
        } else if (mode === 'HEART') {
            // only show a subset of particles to create a soft heart silhouette
            if (this.isDust) {
                s = 0;
            } else {
                // Make heart particles more visible
                s = this.mesh.userData.heartFlag ? this.baseScale * 1.5 : 0;
            }
        }
        
        this.mesh.scale.lerp(new THREE.Vector3(s,s,s), 4*dt);
    }
}

// --- CREATION ---
function createParticles() {
    const sphereGeo = new THREE.SphereGeometry(0.5, 32, 32); 
    const boxGeo = new RoundedBoxGeometry(0.55, 0.55, 0.55, 0.06, 6); 
    const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(0, 0.3, 0),
        new THREE.Vector3(0.1, 0.5, 0), new THREE.Vector3(0.3, 0.4, 0)
    ]);
    const candyGeo = new THREE.TubeGeometry(curve, 16, 0.08, 8, false);

    const goldMat = new THREE.MeshStandardMaterial({
        color: CONFIG.colors.champagneGold,
        metalness: 1.0, roughness: 0.1,
        envMapIntensity: 2.0, 
        emissive: 0x443300,   
        emissiveIntensity: 0.3
    });

    const greenMat = new THREE.MeshStandardMaterial({
        color: CONFIG.colors.deepGreen,
        metalness: 0.2, roughness: 0.8,
        emissive: 0x002200,
        emissiveIntensity: 0.2 
    });

    const redMat = new THREE.MeshPhysicalMaterial({
        color: CONFIG.colors.accentRed,
        metalness: 0.3, roughness: 0.2, clearcoat: 1.0,
        emissive: 0x330000
    });
    
    const candyMat = new THREE.MeshStandardMaterial({ map: caneTexture, roughness: 0.4, metalness: 0.1, side: THREE.DoubleSide });

    for (let i = 0; i < CONFIG.particles.count; i++) {
        const rand = Math.random();
        let mesh, type;
        
        if (rand < 0.55) {
            mesh = new THREE.Mesh(boxGeo, greenMat);
            type = 'BOX';
        } else if (rand < 0.75) {
            mesh = new THREE.Mesh(boxGeo, goldMat);
            type = 'GOLD_BOX';
        } else if (rand < 0.95) {
            mesh = new THREE.Mesh(sphereGeo, goldMat);
            type = 'GOLD_SPHERE';
        } else if (rand < 0.99) {
            mesh = new THREE.Mesh(sphereGeo, redMat);
            type = 'RED';
        } else {
            mesh = new THREE.Mesh(candyGeo, candyMat);
            type = 'CANE';
        }

        let s = 0.4 + Math.random() * 0.5;
        if (type === 'GOLD_SPHERE') s *= 0.8;
        mesh.scale.set(s,s,s);
        mesh.rotation.set(Math.random()*6, Math.random()*6, Math.random()*6);

        if ((type === 'GOLD_SPHERE' || type === 'GOLD_BOX' || type === 'RED')) {
            const blinkChance = (type === 'GOLD_SPHERE' || type === 'GOLD_BOX') ? 0.60 : 0.25;
            if (Math.random() < blinkChance && mesh.material && mesh.material.clone) {
                mesh.material = mesh.material.clone();
                mesh.userData.isBlink = true;
                mesh.userData.baseEmissive = (mesh.material.emissiveIntensity !== undefined && mesh.material.emissiveIntensity > 0) ? mesh.material.emissiveIntensity : 0.6;
                mesh.userData.blinkPhase = Math.random() * Math.PI * 2;
                mesh.userData.blinkSpeed = 2.0 + Math.random() * 2.5;
                mesh.userData.blinkAmp = (type === 'GOLD_BOX' || type === 'GOLD_SPHERE') ? 1.6 + Math.random() * 1.6 : 0.9 + Math.random() * 0.6;
                mesh.userData.blinkColor = (type === 'RED') ? 0xff3333 : 0xffe08a;
                try { mesh.material.emissive = new THREE.Color(mesh.userData.blinkColor); } catch (e) {}
            }
        }

        // allow this particle to participate in HEART shapes (increase to 50% for better visibility)
        mesh.userData.heartFlag = Math.random() < 0.5;
        mainGroup.add(mesh);
        particleSystem.push(new Particle(mesh, type, false));
    }

    const starMat = new THREE.MeshStandardMaterial({
        color: 0xffdd88, emissive: 0xffaa00, emissiveIntensity: 1.0,
        metalness: 1.0, roughness: 0
    });

    function makeStarShape(outerRadius, innerRadius, points) {
        const shape = new THREE.Shape();
        const step = Math.PI / points;
        for (let i = 0; i < points * 2; i++) {
            const r = (i % 2 === 0) ? outerRadius : innerRadius;
            const a = i * step;
            const x = Math.cos(a) * r;
            const y = Math.sin(a) * r;
            if (i === 0) shape.moveTo(x, y);
            else shape.lineTo(x, y);
        }
        shape.closePath();
        return shape;
    }

    const starShape = makeStarShape(1.4, 0.6, 5);
    const extrudeSettings = { depth: 0.35, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.04, bevelSegments: 2 };
    const starGeo = new THREE.ExtrudeGeometry(starShape, extrudeSettings);

    topStar = new THREE.Mesh(starGeo, starMat);
    topStar.position.set(0, CONFIG.particles.treeHeight/2 + 1.2, 0);
    topStar.scale.set(0.9, 0.9, 0.9);
    topStar.rotation.z = Math.PI / 2;
    scene.add(topStar);

    // LOVE MESH - shown when HEART gesture detected
    const loveCanvas = document.createElement('canvas');
    loveCanvas.width = 512; loveCanvas.height = 128;
    const lctx = loveCanvas.getContext('2d');
    lctx.font = 'bold 48px "Times New Roman"';
    lctx.fillStyle = '#FF69B4'; lctx.textAlign = 'center';
    lctx.shadowColor = '#FF1493'; lctx.shadowBlur = 20;
    lctx.fillText('I LOVE YOU ❤️', 256, 80);
    const loveTex = new THREE.CanvasTexture(loveCanvas);
    const loveMat = new THREE.MeshBasicMaterial({ map: loveTex, transparent: true, blending: THREE.AdditiveBlending });
    loveMesh = new THREE.Mesh(new THREE.PlaneGeometry(18, 4.5), loveMat);
    loveMesh.position.set(0, 2, 12);
    loveMesh.visible = false;
    scene.add(loveMesh);
}

function createDust() {
    const geo = new THREE.TetrahedronGeometry(0.08, 0);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffeebb, transparent: true, opacity: 0.8 });
    
    for(let i=0; i<CONFIG.particles.dustCount; i++) {
         const mesh = new THREE.Mesh(geo, mat);
         mesh.scale.setScalar(0.5 + Math.random());
         mainGroup.add(mesh);
         particleSystem.push(new Particle(mesh, 'DUST', true));
    }
}

function addPhotoToScene(texture) {
    const frameGeo = new THREE.BoxGeometry(1.4, 1.4, 0.05);
    const frameMat = new THREE.MeshStandardMaterial({ color: CONFIG.colors.champagneGold, metalness: 1.0, roughness: 0.1 });
    const frame = new THREE.Mesh(frameGeo, frameMat);

    const photoGeo = new THREE.PlaneGeometry(1.2, 1.2);
    const photoMat = new THREE.MeshBasicMaterial({ map: texture });
    const photo = new THREE.Mesh(photoGeo, photoMat);
    photo.position.z = 0.04;

    const group = new THREE.Group();
    group.add(frame);
    group.add(photo);
    
    const s = 0.8;
    group.scale.set(s,s,s);
    
    photoMeshGroup.add(group);
    particleSystem.push(new Particle(group, 'PHOTO', false));
}

function initThree() {
    const container = document.getElementById('canvas-container');
    scene = new THREE.Scene();
    scene.background = new THREE.Color(CONFIG.colors.bg);
    scene.fog = new THREE.FogExp2(CONFIG.colors.bg, 0.01); 

    camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 2, CONFIG.camera.z); 

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ReinhardToneMapping; 
    renderer.toneMappingExposure = 2.2; 
    container.appendChild(renderer.domElement);

    mainGroup = new THREE.Group();
    scene.add(mainGroup);
    // ensure uploaded photos are in the rendered scene
    mainGroup.add(photoMeshGroup);
}

function setupEnvironment() {
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
}

function setupLights() {
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambient);

    const innerLight = new THREE.PointLight(0xffaa00, 2, 20);
    innerLight.position.set(0, 5, 0);
    mainGroup.add(innerLight);

    const spotGold = new THREE.SpotLight(0xffcc66, 1200);
    spotGold.position.set(30, 40, 40);
    spotGold.angle = 0.5;
    spotGold.penumbra = 0.5;
    scene.add(spotGold);

    const spotBlue = new THREE.SpotLight(0x6688ff, 600);
    spotBlue.position.set(-30, 20, -30);
    scene.add(spotBlue);
    
    const fill = new THREE.DirectionalLight(0xffeebb, 0.8);
    fill.position.set(0, 0, 50);
    scene.add(fill);
}

function setupPostProcessing() {
    const renderScene = new RenderPass(scene, camera);
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.5, 0.4, 0.85);
    bloomPass.threshold = 0.7; 
    bloomPass.strength = 0.45; 
    bloomPass.radius = 0.4;

    composer = new EffectComposer(renderer);
    composer.addPass(renderScene);
    composer.addPass(bloomPass);
}

function createTextures() {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 256;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#dd0000';
    const stripeWidth = 40;
    const spacing = stripeWidth * 1.5;
    for (let x = -canvas.height; x < canvas.width + canvas.height; x += spacing) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x + stripeWidth, 0);
        ctx.lineTo(x + stripeWidth + canvas.height, canvas.height);
        ctx.lineTo(x + canvas.height, canvas.height);
        ctx.closePath();
        ctx.fill();
    }

    ctx.fillStyle = '#ffffff';
    const gap = 8;
    for (let x = -canvas.height; x < canvas.width + canvas.height; x += spacing) {
        ctx.beginPath();
        ctx.moveTo(x + stripeWidth - gap, 0);
        ctx.lineTo(x + stripeWidth - gap + (gap * 0.8), 0);
        ctx.lineTo(x + stripeWidth - gap + canvas.height + (gap * 0.8), canvas.height);
        ctx.lineTo(x + canvas.height - gap, canvas.height);
        ctx.closePath();
        ctx.fill();
    }

    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(255,255,255,0.02)';
    for (let i = 0; i < 6; i++) {
        ctx.fillRect(0, i * 40, canvas.width, 2);
    }
    ctx.globalCompositeOperation = 'source-over';

    caneTexture = new THREE.CanvasTexture(canvas);
    caneTexture.wrapS = THREE.RepeatWrapping;
    caneTexture.wrapT = THREE.RepeatWrapping;
    caneTexture.colorSpace = THREE.SRGBColorSpace;
    caneTexture.encoding = THREE.sRGBEncoding;
    try { caneTexture.anisotropy = renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1; } catch (e) { caneTexture.anisotropy = 1; }
    caneTexture.repeat.set(6, 6);
    caneTexture.needsUpdate = true;
}

function processGestures(result) {
    // Debug: Log every call to see if function is being called
    if (!window._gestureDebugCount) window._gestureDebugCount = 0;
    window._gestureDebugCount++;
    if (window._gestureDebugCount % 30 === 0) { // Log every 30 frames to avoid spam
        console.log('processGestures called', {
            hasResult: !!result,
            hasLandmarks: !!(result && result.landmarks),
            landmarksLength: result?.landmarks?.length || 0,
            resultKeys: result ? Object.keys(result) : []
        });
    }
    
    // TWO-HAND HEART DETECTION (index & thumb pinch between hands)
    // Exact same logic as main.html and ver0.1
    if (result && result.landmarks && result.landmarks.length >= 2) {
        const h1 = result.landmarks[0]; 
        const h2 = result.landmarks[1];
        // Check if landmarks are arrays with points
        if (h1 && h1.length >= 21 && h2 && h2.length >= 21) {
            const distIndex = Math.hypot(h1[8].x - h2[8].x, h1[8].y - h2[8].y);
            const distThumb = Math.hypot(h1[4].x - h2[4].x, h1[4].y - h2[4].y);
            
            // Debug log - show when hands are close
            if (distIndex < 0.3 || distThumb < 0.3) {
                console.log('Heart gesture check:', { 
                    distIndex: distIndex.toFixed(3), 
                    distThumb: distThumb.toFixed(3),
                    threshold: 0.15,
                    willActivate: distIndex < 0.15 && distThumb < 0.15
                });
            }
            
            if (distIndex < 0.15 && distThumb < 0.15) {
                STATE.mode = 'HEART';
                STATE.focusTarget = null;
                console.log('❤️ HEART mode activated!');
                return;
            }
        } else {
            // Debug: log structure if not as expected
            if (window._gestureDebugCount % 60 === 0) {
                console.log('Two hands detected but structure unexpected:', {
                    h1_type: typeof h1,
                    h1_length: h1?.length,
                    h1_sample: h1?.[0],
                    h2_length: h2?.length
                });
            }
        }
    }

    if (result.landmarks && result.landmarks.length > 0) {
        STATE.hand.detected = true;
        const lm = result.landmarks[0];
        STATE.hand.x = (lm[9].x - 0.5) * 2; 
        STATE.hand.y = (lm[9].y - 0.5) * 2;

        const thumb = lm[4]; const index = lm[8]; const wrist = lm[0];
        const pinchDist = Math.hypot(thumb.x - index.x, thumb.y - index.y);
        const tips = [lm[8], lm[12], lm[16], lm[20]];
        let avgDist = 0;
        tips.forEach(t => avgDist += Math.hypot(t.x - wrist.x, t.y - wrist.y));
        avgDist /= 4;

        if (pinchDist < 0.05) {
            if (STATE.mode !== 'FOCUS') {
                STATE.mode = 'FOCUS';
                const photos = particleSystem.filter(p => p.type === 'PHOTO');
                if (photos.length) STATE.focusTarget = photos[Math.floor(Math.random()*photos.length)].mesh;
            }
        } else if (avgDist < 0.25) {
            // Don't override HEART mode
            if (STATE.mode !== 'HEART') {
                STATE.mode = 'TREE';
                STATE.focusTarget = null;
            }
        } else if (avgDist > 0.4) {
            // Don't override HEART mode
            if (STATE.mode !== 'HEART') {
                STATE.mode = 'SCATTER';
                STATE.focusTarget = null;
            }
        }
    } else {
        STATE.hand.detected = false;
    }
}

function setupEvents() {
    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
        composer.setSize(window.innerWidth, window.innerHeight);
    });
    
    // Toggle UI logic - ONLY hide controls, keep title
    window.addEventListener('keydown', (e) => {
        const k = e.key.toLowerCase();
        if (k === 'h') {
            const controls = document.querySelector('.upload-wrapper');
            if (controls) controls.classList.toggle('ui-hidden');
        } else if (k === 'c') {
            const wrapper = document.getElementById('webcam-wrapper');
            if (wrapper) wrapper.classList.toggle('ui-hidden');
        }
    });
}

function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();

    if (STATE.mode === 'HEART') {
        // Stop rotation for heart shape
        STATE.rotation.y = THREE.MathUtils.lerp(STATE.rotation.y, 0, dt * 2);
        STATE.rotation.x = THREE.MathUtils.lerp(STATE.rotation.x, 0, dt * 2);
    } else if (STATE.mode === 'SCATTER' && STATE.hand.detected) {
        const targetRotY = STATE.hand.x * Math.PI * 0.9; 
        const targetRotX = STATE.hand.y * Math.PI * 0.25;
        STATE.rotation.y += (targetRotY - STATE.rotation.y) * 3.0 * dt;
        STATE.rotation.x += (targetRotX - STATE.rotation.x) * 3.0 * dt;
    } else {
        if(STATE.mode === 'TREE') {
            STATE.rotation.y += 0.3 * dt;
            STATE.rotation.x += (0 - STATE.rotation.x) * 2.0 * dt;
        } else {
             STATE.rotation.y += 0.1 * dt; 
        }
    }

    mainGroup.rotation.y = STATE.rotation.y;
    mainGroup.rotation.x = STATE.rotation.x;

    // HEART: pulse effect for the entire group
    if (STATE.mode === 'HEART') {
        const beatScale = 1 + Math.abs(Math.sin(clock.elapsedTime * 3)) * 0.15;
        mainGroup.scale.set(beatScale, beatScale, beatScale);
    } else {
        mainGroup.scale.lerp(new THREE.Vector3(1, 1, 1), dt * 2);
    }

    if (topStar) topStar.rotation.y += dt * 1.5;

    particleSystem.forEach(p => p.update(dt, STATE.mode, STATE.focusTarget));

    // HEART: show and pulse love mesh
    if (STATE.mode === 'HEART') {
        if (loveMesh) { 
            loveMesh.visible = true; 
            loveMesh.scale.setScalar(1 + Math.abs(Math.sin(clock.elapsedTime * 3)) * 0.12); 
        }
        // Debug: log mode periodically
        if (Math.floor(clock.elapsedTime * 2) % 2 === 0) {
            console.log('Current mode: HEART', { 
                particles: particleSystem.length,
                heartParticles: particleSystem.filter(p => p.mesh.userData.heartFlag).length
            });
        }
    } else {
        if (loveMesh) loveMesh.visible = false;
    }

    composer.render();
}

async function init() {
    initThree();
    setupEnvironment(); 
    setupLights();
    createTextures();
    createParticles(); 
    createDust();     
    setupPostProcessing();
    setupEvents();

    video = document.getElementById('webcam');
    webcamCanvas = document.getElementById('webcam-preview');
    webcamCtx = webcamCanvas.getContext('2d');

    // initialize mediapipe (in separate module)
    await initMediaPipe({ videoEl: video, canvasEl: webcamCanvas, processResultCallback: processGestures });

    // wire up file input (in separate module)
    initPhotoUpload({ fileInputEl: document.getElementById('file-input'), onImageDataURL: (dataURL) => {
        new THREE.TextureLoader().load(dataURL, (t) => {
            t.colorSpace = THREE.SRGBColorSpace;
            addPhotoToScene(t);
        });
    }});

    const loader = document.getElementById('loader');
    loader.style.opacity = 0;
    setTimeout(() => loader.remove(), 800);

    animate();
}

init();