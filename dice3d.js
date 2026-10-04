/*
 * dice3d.js — Three.js + Rapier dice renderer for the Yahtzee Dice Roller.
 *
 * AI use: Claude (Opus 5) wrote this file — the Rapier physics setup, the headless
 * pre-roll and frame recording, the face-relabelling trick that makes the simulated
 * tumble land on the numbers script.js already chose, and the Three.js scene, lighting
 * and playback loop; reviewed and edited by hand. Three.js and Rapier are third-party
 * libraries loaded from a CDN and are credited in README.md.
 *
 * How the "predetermined" roll works:
 *
 *   1. script.js picks the five results with Math.random().
 *   2. We run the Rapier simulation HEADLESSLY (no rendering) and record the
 *      position + rotation of every die on every step.
 *   3. When the dice have settled we look at the final rotations to see which
 *      face of each cube ended up pointing at the sky.
 *   4. We relabel the cube's six materials so the wanted number sits on that
 *      face - the texture swap happens before a single frame is drawn.
 *   5. We play the recorded frames back as an animation.
 *
 * So the tumble is real physics, not a canned animation, and the result is
 * still whatever the random number generator asked for. Rapier's determinism
 * does not even have to be trusted: we replay recorded transforms rather than
 * re-simulating, so playback matches the pre-roll exactly.
 */

/*
 * These are imported dynamically rather than with a static `import`: a static
 * import that fails takes the whole module down before any of its code runs,
 * so the page could never fall back to the flat CSS dice.
 */
const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
const RAPIER_URL = 'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/rapier.es.js';

let THREE = null;
let RAPIER = null;

/* ------------------------------------------------------------------ config */

const DICE_COUNT = 5;
const HALF = 0.5;                 // half the edge length of a die
const TRAY_X = 4.4;               // half width of the playfield
const TRAY_Z = 2.9;               // half depth of the playfield
const WALL_H = 6;                 // invisible wall height
const RAIL_H = 0.42;              // visible rail height
const GRAVITY = { x: 0, y: -34, z: 0 };

const MAX_STEPS = 480;            // 8 seconds of simulation at 60 Hz
const CALM_FRAMES = 8;            // consecutive still frames that mean "settled"
const MAX_ATTEMPTS = 8;           // re-sims allowed when a die lands cocked
const PLAYBACK_SPEED = 1.35;      // >1 plays the recording back faster

/* Material slot order used by THREE.BoxGeometry:
	 0:+X  1:-X  2:+Y  3:-Y  4:+Z  5:-Z  */
const FACE_DIRECTIONS = [
	[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]
];

const AXES = [[0, 1], [2, 3], [4, 5]];   // opposing face slots
const PAIRS = [[1, 6], [2, 5], [3, 4]];  // opposite faces of a real die sum to 7

/* ------------------------------------------------------------------ state */

let scene, camera, renderer, clock;
let world;
let dice = [];              // { mesh, body }
let faceMaterials = [];     // faceMaterials[value] -> THREE.Material
let playback = null;        // { frames, index, onDone }

/* Reusable maths scratch space, built once the library has loaded. */
let FACE_NORMALS = null;    // FACE_DIRECTIONS as THREE.Vector3
let FIT_CORNERS = null;     // tray corners used to frame the camera
let _q, _v, _fitPoint;

/* ------------------------------------------------------- pip face textures */

function makeFaceTexture(value) {
	const size = 512;
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext('2d');

	ctx.fillStyle = '#f7f3e8';
	ctx.fillRect(0, 0, size, size);

	// soft inner bevel so the cube edges read as edges
	const bevel = ctx.createLinearGradient(0, 0, size, size);
	bevel.addColorStop(0, 'rgba(255,255,255,0.9)');
	bevel.addColorStop(0.5, 'rgba(255,255,255,0)');
	bevel.addColorStop(1, 'rgba(0,0,0,0.12)');
	ctx.fillStyle = bevel;
	ctx.fillRect(0, 0, size, size);

	ctx.strokeStyle = 'rgba(0,0,0,0.10)';
	ctx.lineWidth = size * 0.04;
	ctx.strokeRect(size * 0.02, size * 0.02, size * 0.96, size * 0.96);

	const LOW = 0.27, MID = 0.5, HIGH = 0.73;
	const layouts = {
		1: [[MID, MID]],
		2: [[LOW, LOW], [HIGH, HIGH]],
		3: [[LOW, LOW], [MID, MID], [HIGH, HIGH]],
		4: [[LOW, LOW], [HIGH, LOW], [LOW, HIGH], [HIGH, HIGH]],
		5: [[LOW, LOW], [HIGH, LOW], [MID, MID], [LOW, HIGH], [HIGH, HIGH]],
		6: [[LOW, LOW], [HIGH, LOW], [LOW, MID], [HIGH, MID], [LOW, HIGH], [HIGH, HIGH]]
	};

	const radius = value === 1 ? size * 0.115 : size * 0.082;
	layouts[value].forEach(function (spot) {
		const x = spot[0] * size;
		const y = spot[1] * size;

		ctx.beginPath();
		ctx.arc(x, y + size * 0.012, radius, 0, Math.PI * 2);
		ctx.fillStyle = 'rgba(0,0,0,0.18)';
		ctx.fill();

		ctx.beginPath();
		ctx.arc(x, y, radius, 0, Math.PI * 2);
		ctx.fillStyle = value === 1 ? '#b0332c' : '#23201b';
		ctx.fill();
	});

	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.anisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 1;
	return texture;
}

/* ------------------------------------------------------------ scene set-up */

function buildScene(container) {
	renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = THREE.PCFSoftShadowMap;
	container.appendChild(renderer.domElement);

	scene = new THREE.Scene();
	camera = new THREE.PerspectiveCamera(38, 1.8, 0.1, 100);
	clock = new THREE.Clock();

	scene.add(new THREE.HemisphereLight(0xffffff, 0x1d6b4f, 0.65));
	scene.add(new THREE.AmbientLight(0xffffff, 0.25));

	const key = new THREE.DirectionalLight(0xfff3d6, 1.35);
	key.position.set(5, 12, 6);
	key.castShadow = true;
	key.shadow.mapSize.set(2048, 2048);
	key.shadow.camera.left = -9;
	key.shadow.camera.right = 9;
	key.shadow.camera.top = 9;
	key.shadow.camera.bottom = -9;
	key.shadow.camera.far = 40;
	key.shadow.bias = -0.0008;
	scene.add(key);

	const fill = new THREE.DirectionalLight(0xbfe6d2, 0.35);
	fill.position.set(-6, 5, -4);
	scene.add(fill);

	// felt
	const felt = new THREE.Mesh(
		new THREE.PlaneGeometry(TRAY_X * 2, TRAY_Z * 2),
		new THREE.MeshStandardMaterial({ color: 0x17573f, roughness: 1, metalness: 0 })
	);
	felt.rotation.x = -Math.PI / 2;
	felt.receiveShadow = true;
	scene.add(felt);

	// wooden rails
	const railMaterial = new THREE.MeshStandardMaterial({
		color: 0x6f4a24, roughness: 0.65, metalness: 0.15
	});
	const rails = [
		[TRAY_X * 2 + 0.6, RAIL_H, 0.3, 0, RAIL_H / 2, TRAY_Z + 0.15],
		[TRAY_X * 2 + 0.6, RAIL_H, 0.3, 0, RAIL_H / 2, -TRAY_Z - 0.15],
		[0.3, RAIL_H, TRAY_Z * 2, TRAY_X + 0.15, RAIL_H / 2, 0],
		[0.3, RAIL_H, TRAY_Z * 2, -TRAY_X - 0.15, RAIL_H / 2, 0]
	];
	rails.forEach(function (r) {
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(r[0], r[1], r[2]), railMaterial);
		mesh.position.set(r[3], r[4], r[5]);
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		scene.add(mesh);
	});

	faceMaterials = [null];
	for (let value = 1; value <= 6; value++) {
		const material = new THREE.MeshStandardMaterial({
			map: makeFaceTexture(value),
			roughness: 0.45,
			metalness: 0.05
		});
		material.name = 'die-face-' + value;
		material.userData.value = value;
		faceMaterials.push(material);
	}

	const geometry = new THREE.BoxGeometry(HALF * 2, HALF * 2, HALF * 2);
	for (let i = 0; i < DICE_COUNT; i++) {
		const mesh = new THREE.Mesh(geometry, faceMaterials.slice(1));
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		scene.add(mesh);
		dice.push({ mesh: mesh, body: null });
	}
}

/*
 * Frames the whole tray no matter how wide or narrow the canvas is: pull the
 * camera back until every corner of the tray (plus head-room for a die
 * bouncing near the front rail) projects inside the viewport.
 */
function fitCamera() {
	/* On a narrow canvas a more overhead angle lets the tray fill more of it. */
	const direction = (camera.aspect < 1.35
		? new THREE.Vector3(0, 0.94, 0.34)
		: new THREE.Vector3(0, 0.80, 0.60)).normalize();
	let dist = 14;

	for (let pass = 0; pass < 6; pass++) {
		camera.position.copy(direction).multiplyScalar(dist);
		camera.lookAt(0, 0, 0);
		camera.updateMatrixWorld();
		camera.updateProjectionMatrix();

		let worst = 0;
		FIT_CORNERS.forEach(function (corner) {
			_fitPoint.copy(corner).project(camera);
			worst = Math.max(worst, Math.abs(_fitPoint.x), Math.abs(_fitPoint.y));
		});

		if (worst > 0.985 && worst < 0.995) break;
		dist *= worst / 0.99;
	}

	camera.position.copy(direction).multiplyScalar(dist);
	camera.lookAt(0, 0, 0);
}

function resize(container) {
	const width = container.clientWidth;
	const height = container.clientHeight;
	if (!width || !height) return;
	renderer.setSize(width, height, false);
	camera.aspect = width / height;
	camera.updateProjectionMatrix();
	fitCamera();
}

/* --------------------------------------------------------------- physics */

function buildWorld() {
	world = new RAPIER.World(GRAVITY);

	const floor = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
	world.createCollider(
		RAPIER.ColliderDesc.cuboid(TRAY_X, 0.5, TRAY_Z).setRestitution(0.2).setFriction(0.85),
		floor
	);

	const walls = [
		[0.5, WALL_H / 2, TRAY_Z + 1, TRAY_X + 0.5, WALL_H / 2, 0],
		[0.5, WALL_H / 2, TRAY_Z + 1, -TRAY_X - 0.5, WALL_H / 2, 0],
		[TRAY_X + 1, WALL_H / 2, 0.5, 0, WALL_H / 2, TRAY_Z + 0.5],
		[TRAY_X + 1, WALL_H / 2, 0.5, 0, WALL_H / 2, -TRAY_Z - 0.5]
	];
	walls.forEach(function (w) {
		const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(w[3], w[4], w[5]));
		world.createCollider(
			RAPIER.ColliderDesc.cuboid(w[0], w[1], w[2]).setRestitution(0.35).setFriction(0.6),
			body
		);
	});

	dice.forEach(function (die) {
		const body = world.createRigidBody(
			RAPIER.RigidBodyDesc.dynamic()
				.setTranslation(0, 3, 0)
				.setLinearDamping(0.22)
				.setAngularDamping(0.32)
				.setCcdEnabled(true)
		);
		world.createCollider(
			RAPIER.ColliderDesc.cuboid(HALF, HALF, HALF)
				.setRestitution(0.32)
				.setFriction(0.7)
				.setDensity(1.4),
			body
		);
		die.body = body;
	});
}

function randomQuaternion() {
	const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
		Math.random() * Math.PI * 2,
		Math.random() * Math.PI * 2,
		Math.random() * Math.PI * 2
	));
	return { x: q.x, y: q.y, z: q.z, w: q.w };
}

/* Throws the dice in from above with a random tumble. */
function resetBodies() {
	dice.forEach(function (die, i) {
		const x = -3.0 + i * 1.5 + (Math.random() - 0.5) * 0.5;
		const y = 3.2 + Math.random() * 1.4;
		const z = -TRAY_Z * 0.55 + (Math.random() - 0.5) * 0.8;

		die.body.setTranslation({ x: x, y: y, z: z }, true);
		die.body.setRotation(randomQuaternion(), true);
		die.body.setLinvel({
			x: -x * 0.55 + (Math.random() - 0.5) * 3,
			y: -4 - Math.random() * 3,
			z: 3 + Math.random() * 3.5
		}, true);
		die.body.setAngvel({
			x: (Math.random() - 0.5) * 34,
			y: (Math.random() - 0.5) * 34,
			z: (Math.random() - 0.5) * 34
		}, true);
		die.body.wakeUp();
	});
}

function atRest() {
	return dice.every(function (die) {
		if (die.body.isSleeping()) return true;
		const v = die.body.linvel();
		const a = die.body.angvel();
		return (v.x * v.x + v.y * v.y + v.z * v.z) < 0.02 &&
					 (a.x * a.x + a.y * a.y + a.z * a.z) < 0.05;
	});
}

/* Which material slot is pointing at the sky, and is the die lying flat? */
function upFace(rotation) {
	_q.set(rotation.x, rotation.y, rotation.z, rotation.w);
	let best = 0;
	let bestDot = -Infinity;
	for (let i = 0; i < 6; i++) {
		_v.copy(FACE_NORMALS[i]).applyQuaternion(_q);
		if (_v.y > bestDot) {
			bestDot = _v.y;
			best = i;
		}
	}
	return { index: best, flat: bestDot > 0.9 };
}

/*
 * Runs the whole roll without drawing anything, and returns the recorded
 * frames plus the material slot that ended up on top for each die.
 * A cocked die (resting on an edge) just means we throw again.
 */
function simulate() {
	let recording = null;
	let landed = null;

	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		resetBodies();

		const frames = [];
		let calm = 0;

		for (let step = 0; step < MAX_STEPS; step++) {
			world.step();

			const frame = new Float32Array(DICE_COUNT * 7);
			dice.forEach(function (die, i) {
				const t = die.body.translation();
				const r = die.body.rotation();
				const o = i * 7;
				frame[o] = t.x; frame[o + 1] = t.y; frame[o + 2] = t.z;
				frame[o + 3] = r.x; frame[o + 4] = r.y; frame[o + 5] = r.z; frame[o + 6] = r.w;
			});
			frames.push(frame);

			if (atRest()) {
				calm++;
				if (calm >= CALM_FRAMES) break;
			} else {
				calm = 0;
			}
		}

		const faces = dice.map(function (die) { return upFace(die.body.rotation()); });
		recording = frames;
		landed = faces.map(function (f) { return f.index; });

		if (faces.every(function (f) { return f.flat; })) break;
	}

	return { frames: recording, landed: landed };
}

/* ------------------------------------------------------- the texture swap */

/*
 * Builds the six face values for one die so that `target` sits on the slot
 * that physics chose, keeping opposite faces summing to 7. The remaining
 * pairs are assigned at random, so the sides of the die differ from roll to
 * roll. (Half of those arrangements are a mirrored die - invisible in play.)
 */
function buildFaceValues(landedIndex, target) {
	const values = new Array(6);

	const axis = AXES.findIndex(function (a) { return a.indexOf(landedIndex) !== -1; });
	const opposite = AXES[axis][0] === landedIndex ? AXES[axis][1] : AXES[axis][0];
	values[landedIndex] = target;
	values[opposite] = 7 - target;

	const remaining = PAIRS.filter(function (p) { return p.indexOf(target) === -1; });
	if (Math.random() < 0.5) remaining.reverse();

	const otherAxes = AXES.filter(function (_, i) { return i !== axis; });
	otherAxes.forEach(function (slots, i) {
		const pair = remaining[i];
		const flip = Math.random() < 0.5;
		values[slots[0]] = flip ? pair[1] : pair[0];
		values[slots[1]] = flip ? pair[0] : pair[1];
	});

	return values;
}

function applyFaceValues(die, landedIndex, target) {
	const values = buildFaceValues(landedIndex, target);
	die.mesh.material = values.map(function (v) { return faceMaterials[v]; });
}

/* ------------------------------------------------------------- animation */

function applyFrame(frame) {
	dice.forEach(function (die, i) {
		const o = i * 7;
		die.mesh.position.set(frame[o], frame[o + 1], frame[o + 2]);
		die.mesh.quaternion.set(frame[o + 3], frame[o + 4], frame[o + 5], frame[o + 6]);
	});
}

function tick() {
	requestAnimationFrame(tick);

	const delta = clock.getDelta();

	if (playback) {
		playback.index += delta * 60 * PLAYBACK_SPEED;

		if (playback.index >= playback.frames.length - 1) {
			applyFrame(playback.frames[playback.frames.length - 1]);
			const done = playback.onDone;
			playback = null;
			if (done) done();
		} else {
			applyFrame(playback.frames[Math.floor(playback.index)]);
		}
	}

	renderer.render(scene, camera);
}

/* ------------------------------------------------------------ public API */

function roll(values, onDone) {
	const result = simulate();

	// Swap the textures before the first frame is drawn.
	dice.forEach(function (die, i) {
		applyFaceValues(die, result.landed[i], values[i]);
	});

	applyFrame(result.frames[0]);
	playback = { frames: result.frames, index: 0, onDone: onDone };
	clock.getDelta();
}

/**
 * Diagnostic hook: for each rendered die, the number actually facing the sky
 * and whether it is lying flat. The value should always equal what the random
 * number generator asked for.
 */
function inspect() {
	return dice.map(function (die) {
		const face = upFace(die.mesh.quaternion);
		return { value: die.mesh.material[face.index].userData.value, flat: face.flat };
	});
}

/* ----------------------------------------------------------------- start */

/* Pulls in Three.js and Rapier, then builds everything that needs them. */
async function loadLibraries() {
	const [three, rapier] = await Promise.all([import(THREE_URL), import(RAPIER_URL)]);
	THREE = three;
	RAPIER = rapier.default || rapier;

	await RAPIER.init();

	FACE_NORMALS = FACE_DIRECTIONS.map(function (d) {
		return new THREE.Vector3(d[0], d[1], d[2]);
	});

	FIT_CORNERS = [];
	const x = TRAY_X + 0.45;
	const z = TRAY_Z + 0.45;
	[0, 1.4].forEach(function (y) {
		[-x, x].forEach(function (cx) {
			[-z, z].forEach(function (cz) {
				FIT_CORNERS.push(new THREE.Vector3(cx, y, cz));
			});
		});
	});

	_q = new THREE.Quaternion();
	_v = new THREE.Vector3();
	_fitPoint = new THREE.Vector3();
}

async function start() {
	const container = document.getElementById('stage');
	if (!container) throw new Error('missing #stage container');

	await loadLibraries();

	buildScene(container);
	buildWorld();

	container.hidden = false;
	/* Decorative: the numbers are announced through the labelled result fields. */
	container.setAttribute('aria-hidden', 'true');
	document.body.classList.add('has-3d');
	resize(container);
	window.addEventListener('resize', function () { resize(container); });

	// Warm the physics up and show a settled tray straight away, so the scene
	// is never a stack of dice sitting at the origin.
	const warmUp = simulate();
	applyFrame(warmUp.frames[warmUp.frames.length - 1]);
	requestAnimationFrame(tick);

	window.DiceApp.use3D({ roll: roll, inspect: inspect });
}

try {
	await start();
} catch (error) {
	console.warn('3D dice unavailable, falling back to 2D:', error);
	if (window.DiceApp && window.DiceApp.fallbackTo2D) {
		window.DiceApp.fallbackTo2D();
	}
}
