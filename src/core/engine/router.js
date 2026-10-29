'use strict';

var js_pcb = require('./layer.js');
const geometry = require('../geometry.js');
const routeFixed = require('./fixed.js');
(function () {
	function shuffle(items, random) {
		for (let i = items.length - 1; i > 0; i--) {
			const j = Math.floor(random() * (i + 1));
			[items[i], items[j]] = [items[j], items[i]];
		}
	}

	function move(items, oldIndex, newIndex) {
		items.splice(newIndex, 0, items.splice(oldIndex, 1)[0]);
	}

	const spacial_hash_res = 0.75;

	//aabb of terminals
	function aabb_terminals(terms, quantization) {
		if (!terms || !terms.length) return [0, [0, 0, 0, 0]];
		let minx = (Math.trunc(terms[0][2][0]) / quantization) * quantization;
		let miny = (Math.trunc(terms[0][2][1]) / quantization) * quantization;
		let maxx = ((Math.trunc(terms[0][2][0]) + (quantization - 1)) / quantization) * quantization;
		let maxy = ((Math.trunc(terms[0][2][1]) + (quantization - 1)) / quantization) * quantization;
		for (let i = 1; i < terms.length; ++i) {
			let tminx = (Math.trunc(terms[i][2][0]) / quantization) * quantization;
			let tminy = (Math.trunc(terms[i][2][1]) / quantization) * quantization;
			let tmaxx = ((Math.trunc(terms[i][2][0]) + (quantization - 1)) / quantization) * quantization;
			let tmaxy = ((Math.trunc(terms[i][2][1]) + (quantization - 1)) / quantization) * quantization;
			minx = Math.min(tminx, minx);
			miny = Math.min(tminy, miny);
			maxx = Math.max(tmaxx, maxx);
			maxy = Math.max(tmaxy, maxy);
		}
		return [(maxx - minx) * (maxy - miny), [minx, miny, maxx, maxy]];
	}

	// 无碰撞的默认 key（节点坐标异常时使用）。
	function default_node_key(n) {
		return 'oob:' + n[0] + ',' + n[1] + ',' + n[2];
	}

	// NodeSet 使用调用方提供的 key 函数。Pcb 会传入基于板子尺寸、
	// 带范围校验的数值 key；超出范围或非整数坐标自动退化为字符串 key，
	// 避免固定基数编码在超大坐标/超精度时发生碰撞。
	class NodeSet {
		constructor(init, keyFn) {
			this._key = keyFn || default_node_key;
			if (init === undefined) this._data = new Map();
			else if (init instanceof NodeSet) {
				this._data = new Map(init._data);
				this._key = init._key;
			} else {
				this._data = new Map();
				for (let n of init) this._data.set(this._key(n), n);
			}
			this.size = this._data.size;
		}

		add(n) {
			let k = this._key(n);
			if (!this._data.has(k)) {
				this._data.set(k, n);
				this.size += 1;
			}
		}

		has(n) {
			return this._data.has(this._key(n));
		}

		[Symbol.iterator]() {
			return this._data.values();
		}
	}

	//pcb class
	class Pcb {
		constructor(dims, rfvs, rpvs, dfunc, res, verb, quant, viascost, hooks = {}) {
			let w, h, d;
			[w, h, d] = dims;
			this.m_width = w * res;
			this.now = hooks.now || Date.now;
			this.notify = hooks.onEvent || function () {};
			this.random = hooks.random || Math.random;
			this.isCancelled =
				hooks.isCancelled ||
				function () {
					return false;
				};
			this.m_run_deadline = hooks.deadline ?? Infinity;
			this.m_keepouts = [];
			this.m_height = h * res;
			this.m_stride = this.m_width * this.m_height;
			this.m_depth = d;
			this.m_routing_flood_vectors = rfvs;
			this.m_routing_path_vectors = rpvs;
			this.m_dfunc = dfunc;
			this.m_resolution = res;
			this.m_verbosity = verb;
			this.m_quantization = quant * res;
			this.m_viascost = viascost * res;
			this.m_layers = new js_pcb.Layers([Math.trunc(w * spacial_hash_res), Math.trunc(h * spacial_hash_res), d], spacial_hash_res / res);
			this.m_deform = new Map();
			this.m_netlist = [];
			this.m_nodes = new Uint32Array(this.m_stride * this.m_depth);
			this.m_via_vectors = [
				[
					[0, 0, -1],
					[0, 0, 1],
				],
				[
					[0, 0, -1],
					[0, 0, 1],
				],
			];
			// 使用板子尺寸作为编码基数：key = (z * height + y) * width + x。
			// 所有节点都在 [0,width) x [0,height) x [0,depth) 内，因此不会碰撞；
			// 越界/非整数节点退化为字符串 key（Map 的 number/string key 不会互相冲突）。
			const w_key = this.m_width;
			const h_key = this.m_height;
			const d_key = this.m_depth;
			const numeric_safe = w_key > 0 && h_key > 0 && d_key > 0 && w_key * h_key * d_key <= Number.MAX_SAFE_INTEGER;
			this.m_node_key = function (n) {
				const x = n[0],
					y = n[1],
					z = n[2];
				if (
					numeric_safe &&
					Number.isInteger(x) &&
					Number.isInteger(y) &&
					Number.isInteger(z) &&
					x >= 0 &&
					x < w_key &&
					y >= 0 &&
					y < h_key &&
					z >= 0 &&
					z < d_key
				) {
					return (z * h_key + y) * w_key + x;
				}
				return default_node_key(n);
			};
		}

		//add net
		add_track(track) {
			let track_radius, via_radius, track_gap, terminals, paths;
			[track_radius, via_radius, track_gap, terminals, paths] = track;
			const name = track[5] || 'net-' + this.m_netlist.length;
			this.m_netlist.push(new Net(track_radius, via_radius, track_gap, terminals, this, name, track[6] || {}));
			for (const [pathIndex, path] of (paths || []).entries())
				for (let i = 1; i < path.length; i++)
					this.add_fixed_route({
						id: 'input:' + name + ':' + pathIndex + ':' + i,
						net: name,
						radius: path[i - 1][2] === path[i][2] ? track_radius : via_radius,
						points: [path[i - 1], path[i]],
					});
		}

		expired() {
			if (this.isCancelled()) {
				this.m_cancelled = true;
				return true;
			}
			return this.now() >= (this.m_deadline ?? Infinity);
		}

		add_fixed_route(route) {
			const net = this.m_netlist.find((item) => item.m_name === route.net);
			if (!net) throw new Error('Unknown fixed-route net: ' + route.net);
			const fixed = {
				...route,
				originalPoints: route.points.map((p) => p.slice()),
				points: route.points.map((p) => [p[0] * this.m_resolution, p[1] * this.m_resolution, p[2]]),
				radius: route.radius * this.m_resolution,
			};
			net.m_fixed.push(fixed);
			net.fixed_collision(fixed, true);
		}

		add_keepout(keepout) {
			this.m_keepouts.push({
				...keepout,
				points: keepout.points.map((p) => [p[0] * this.m_resolution, p[1] * this.m_resolution]),
				gap: keepout.gap * this.m_resolution,
			});
		}

		hit_keepout(a, b, radius, gap) {
			return this.m_keepouts.some((region) => {
				if (region.kind === 'via' && a[2] === b[2]) return false;
				if (!region.layers.some((z) => z >= Math.min(a[2], b[2]) && z <= Math.max(a[2], b[2]))) return false;
				return geometry.polygonDistance(a, b, region.points) < radius + Math.max(gap, region.gap) + geometry.EPS;
			});
		}

		//add board outline as walls on every layer, so traces/vias keep
		//clearance from the board edge (points are in board space)
		add_wall(points, gap) {
			if (!points || !points.length) return;
			// 支持多个 boundary path（外框 + 挖槽/开孔）
			if (Array.isArray(points[0]) && points[0].length && Array.isArray(points[0][0])) {
				for (let poly of points) this.add_wall(poly, gap);
				return;
			}
			if (points.length < 2) return;
			for (let i = 0; i < points.length; ++i) {
				let a = points[i];
				let b = points[(i + 1) % points.length];
				if (a[0] === b[0] && a[1] === b[1]) continue;
				for (let z = 0; z < this.m_depth; ++z) {
					this.m_layers.add_line([a[0], a[1], z], [b[0], b[1], z], 0.0, gap);
				}
			}
		}

		//remove netlist from board
		remove_netlist() {
			for (let net of this.m_netlist) net.remove();
		}

		//attempt to route board within time
		route(timeout) {
			// timeout 单位为秒，<=0 表示不限制。
			// 原实现把超时检测注释掉了，导致板子复杂时会一直算下去没有任何输出。
			this.m_timedout = false;
			this.m_deadline = Math.min(timeout > 0 ? this.now() + timeout * 1000 : Infinity, this.m_run_deadline);
			this.m_last_output_time = 0;
			this.remove_netlist();
			this.unmark_distances();
			this.reset_areas();
			this.shuffle_netlist();
			this.m_netlist.sort(function (n1, n2) {
				if (n1.m_priority !== n2.m_priority) return n2.m_priority - n1.m_priority;
				if (n1.m_area === n2.m_area) return n1.m_radius - n2.m_radius;
				return n1.m_area - n2.m_area;
			});
			let hoisted_nets = new Set();
			// 记录每个网络失败的次数。原实现会无限地“重排 + 重试”，
			// 一旦某个网络在当前板框/规则下布不通，整块板就会永远卡住。
			// 达到上限后跳过该网络，先保证其余网络能布完。
			let attempts = new Map();
			const max_attempts = this.m_max_attempts || 4;
			let index = 0;
			//		let start_time = std::chrono::high_resolution_clock::now();
			while (index < this.m_netlist.length) {
				if (this.expired()) {
					this.m_timedout = true;
					break;
				}
				const current_net = this.m_netlist[index];
				if ((attempts.get(current_net) || 0) >= max_attempts) {
					// 放弃该网络，保留其它已布通的网络
					this.notify({
						type: 'log',
						key: 'log.netSkip',
						args: [index + 1, this.m_netlist.length, max_attempts],
					});
					index++;
					continue;
				}
				if (current_net.route()) index++;
				else {
					const tries = (attempts.get(current_net) || 0) + 1;
					attempts.set(current_net, tries);
					if (this.m_timedout) break;
					this.notify({
						type: 'log',
						key: 'log.netRetry',
						args: [index + 1, this.m_netlist.length, current_net.m_terminals.length, tries],
					});
					if (index === 0) {
						this.reset_areas();
						this.shuffle_netlist();
						this.m_netlist.sort(function (n1, n2) {
							if (n1.m_priority !== n2.m_priority) return n2.m_priority - n1.m_priority;
							if (n1.m_area === n2.m_area) return n1.m_radius - n2.m_radius;
							return n1.m_area - n2.m_area;
						});
						hoisted_nets.clear();
					} else {
						let pos = this.hoist_net(index);
						if (pos === index || hoisted_nets.has(this.m_netlist[pos])) {
							if (pos !== 0) {
								this.m_netlist[pos].m_area = this.m_netlist[pos - 1].m_area;
								pos = this.hoist_net(pos);
							}
							hoisted_nets.delete(this.m_netlist[pos]);
						} else hoisted_nets.add(this.m_netlist[pos]);
						while (index > pos) {
							this.m_netlist[index].remove();
							this.m_netlist[index].shuffle_topology();
							index--;
						}
					}
				}
				//			let end_time = std::chrono::high_resolution_clock::now();
				//			std::chrono::duration<float> elapsed = end_time - start_time;
				//			if (elapsed.count() >= timeout) return false;
				// 约 4 次/秒回传进度和当前布线快照。
				// 进度用进度条显示，日志里不再刷屏“布线进度”。
				let now = this.now();
				if (now - this.m_last_output_time >= 250) {
					this.m_last_output_time = now;
					let routed = 0;
					let total = 0;
					for (let net of this.m_netlist) {
						if (net.m_radius === 0.0) continue;
						total++;
						if (net.m_routed || net.m_paths.length) routed++;
					}
					this.notify({ type: 'progress', done: routed, total: total });
					if (this.m_verbosity >= 1) this.notify(this.output_pcb());
				}
			}
			return !this.m_timedout;
		}

		//cost of board in complexity terms
		cost() {
			// 未布通的网络必须施加极大的惩罚，否则“一条线都没布”的板子
			// 反而因为总长度最小而被当成最优解（原实现就是这个行为）。
			let sum = 0;
			let unrouted = 0;
			for (let net of this.m_netlist) {
				if (net.m_radius === 0.0) continue; // 无电气连接的虚拟网络
				if (!net.m_routed && net.m_paths.length === 0) {
					unrouted++;
					continue;
				}
				for (let path of net.m_paths) sum += path.length;
			}
			return sum + unrouted * 1e9;
		}

		//number of electrically connected nets that have no path
		unrouted_nets() {
			let count = 0;
			for (let net of this.m_netlist) if (net.m_radius > 0.0 && !net.m_routed && net.m_paths.length === 0) count++;
			return count;
		}

		//number of electrically connected nets
		connected_nets() {
			let count = 0;
			for (let net of this.m_netlist) if (net.m_radius > 0.0) count++;
			return count;
		}

		//increase area quantization
		increase_quantization() {
			this.m_quantization++;
		}

		//output netlist and paths of board for viewer app
		output_pcb() {
			let scale = 1.0 / this.m_resolution;
			let tracks = [];
			for (let net of this.m_netlist) {
				tracks.push(net.output_net());
				for (const fixed of net.m_fixed)
					tracks.push([
						fixed.radius / this.m_resolution,
						net.m_via * scale,
						net.m_gap * scale,
						[],
						[fixed.originalPoints.map((p) => p.slice())],
						net.m_name,
						{ protected: true, id: fixed.id },
					]);
			}
			return [[Math.trunc(this.m_width * scale), Math.trunc(this.m_height * scale), this.m_depth], tracks];
		}

		//convert grid node to space node
		grid_to_space_point(n) {
			let p = this.m_deform.get(n.toString());
			if (p !== undefined) {
				return p;
			}
			return n;
		}

		//set grid node to value
		set_node(n, value) {
			this.m_nodes[this.m_stride * n[2] + n[1] * this.m_width + n[0]] = value;
		}

		//get grid node value
		get_node(n) {
			return this.m_nodes[this.m_stride * n[2] + n[1] * this.m_width + n[0]];
		}

		//generate all grid points surrounding node, that are not value 0
		all_marked(vec, n) {
			let w = this.m_width;
			let h = this.m_height;
			let d = this.m_depth;
			let gn = this.get_node;
			let sort_nodes = [];
			let x, y, z;
			[x, y, z] = n;
			for (let v of vec[z % 2]) {
				let nx, ny, nz;
				[nx, ny, nz] = v;
				(nx += x), (ny += y), (nz += z);
				if (0 <= nx && nx < w && 0 <= ny && ny < h && 0 <= nz && nz < d) {
					let n = [nx, ny, nz];
					let mark = gn.call(this, n);
					if (mark !== 0) sort_nodes.push([mark, n]);
				}
			}
			return sort_nodes;
		}

		//generate all grid points surrounding node, that are value 0
		all_not_marked(vec, n) {
			let w = this.m_width;
			let h = this.m_height;
			let d = this.m_depth;
			let gn = this.get_node;
			let nodes = [];
			let x, y, z;
			[x, y, z] = n;
			for (let v of vec[z % 2]) {
				let nx, ny, nz;
				[nx, ny, nz] = v;
				(nx += x), (ny += y), (nz += z);
				if (0 <= nx && nx < w && 0 <= ny && ny < h && 0 <= nz && nz < d) {
					let n = [nx, ny, nz];
					if (gn.call(this, n) === 0) nodes.push(n);
				}
			}
			return nodes;
		}

		//generate all grid points surrounding node sorted
		all_nearer_sorted(vec, n, dfunc) {
			let gsp = this.grid_to_space_point;
			let gp = gsp.call(this, n);
			let distance = this.get_node(n);
			let marked_nodes = this.all_marked(vec, n).filter((mn) => {
				if (distance - mn[0] <= 0) return false;
				mn[0] = dfunc(gsp.call(this, mn[1]), gp);
				return true;
			});
			marked_nodes.sort(function (s1, s2) {
				return s1[0] - s2[0];
			});
			return marked_nodes.map(function (mn) {
				return mn[1];
			});
		}

		//generate all grid points surrounding node that are not shorting with an existing track
		all_not_shorting(gather, n, radius, gap) {
			let gsp = this.grid_to_space_point;
			let layers = this.m_layers;
			let hit_line = this.m_layers.hit_line;
			let nodes = [];
			let np = gsp.call(this, n);
			for (let new_node of gather) {
				let nnp = gsp.call(this, new_node);
				if (!hit_line.call(layers, np, nnp, radius, gap) && !this.hit_keepout(np, nnp, radius, gap)) nodes.push(new_node);
			}
			return nodes;
		}

		//flood fill distances from starts till ends covered
		mark_distances(vec, radius, via, gap, starts, ends) {
			let gn = this.get_node;
			let sn = this.set_node;
			let anm = this.all_not_marked;
			let ans = this.all_not_shorting;
			let via_vectors = this.m_via_vectors;
			let distance = 1;
			let frontier = new NodeSet(starts);
			let vias_nodes = new Map();
			let ticks = 0;
			while (frontier.size || vias_nodes.size) {
				if ((ticks++ & 0x3ff) === 0 && this.expired()) return false;
				for (let node of frontier) sn.call(this, node, distance);
				if (
					ends.every((node) => {
						return gn.call(this, node);
					})
				)
					break;
				let new_nodes = new NodeSet(undefined, this.m_node_key);
				let inner = 0;
				for (let node of frontier) {
					if ((inner++ & 0x3ff) === 0 && this.expired()) return false;
					for (let new_node of ans.call(this, anm.call(this, vec, node), node, radius, gap)) {
						new_nodes.add(new_node);
					}
				}
				let new_vias_nodes = new NodeSet(undefined, this.m_node_key);
				inner = 0;
				for (let node of frontier) {
					if ((inner++ & 0x3ff) === 0 && this.expired()) return false;
					for (let new_node of ans.call(this, anm.call(this, via_vectors, node), node, via, gap)) {
						new_vias_nodes.add(new_node);
					}
				}
				if (new_vias_nodes.size) vias_nodes.set(distance + this.m_viascost, new_vias_nodes);
				let delay_nodes = vias_nodes.get(distance);
				if (delay_nodes !== undefined) {
					for (let node of delay_nodes) if (gn.call(this, node) === 0) new_nodes.add(node);
					vias_nodes.delete(distance);
				}
				frontier = new_nodes;
				distance++;
			}
			return true;
		}

		//set all grid values back to 0
		unmark_distances() {
			this.m_nodes.fill(0);
		}

		//reset areas
		reset_areas() {
			for (let net of this.m_netlist) {
				[net.m_area, net.m_bbox] = aabb_terminals(net.m_terminals, this.m_quantization);
			}
		}

		//shuffle order of netlist
		shuffle_netlist() {
			shuffle(this.m_netlist, this.random);
			for (let net of this.m_netlist) net.shuffle_topology();
		}

		//move net to top of area group
		hoist_net(n) {
			let i = 0;
			if (n != 0) {
				for (i = n; i >= 0; --i)
					if (
						this.m_netlist[i].m_priority > this.m_netlist[n].m_priority ||
						(this.m_netlist[i].m_priority === this.m_netlist[n].m_priority && this.m_netlist[i].m_area < this.m_netlist[n].m_area)
					)
						break;
				i++;
				if (n != i) {
					move(this.m_netlist, n, i);
				}
			}
			return i;
		}
	}

	// 连通性：只允许焊盘实际存在的层。缺失层信息时返回空数组，
	// 该网络会被判定为无法布线，避免把单层焊盘误当成跨层可连接。
	function terminal_connect_layers(node) {
		return node[4] && node[4].length ? node[4] : [];
	}

	// 碰撞：层信息缺失时保守地阻挡所有层，避免走线穿过未知焊盘。
	function terminal_collision_layers(node, depth) {
		let layers = node[4];
		if (layers && layers.length) return layers;
		let all = [];
		for (let z = 0; z < depth; ++z) all.push(z);
		return all;
	}

	// 焊盘在第 z 层的实际几何（多层 padstack 可能每层形状/尺寸不同）
	function terminal_layer_shape(node, z) {
		let shapes = node[5];
		return shapes && shapes[z] ? shapes[z] : null;
	}

	//scale terminals for resolution of grid
	function scale_terminals(terms, res) {
		for (let term of terms) {
			term[0] *= res;
			term[1] *= res;
			term[2][0] *= res;
			term[2][1] *= res;
			for (let p of term[3]) {
				p[0] *= res;
				p[1] *= res;
			}
			// 每层独立的焊盘几何
			let layer_shapes = term[5] || [];
			for (let ls of layer_shapes) {
				if (!ls) continue;
				ls.r *= res;
				for (let p of ls.points) {
					p[0] *= res;
					p[1] *= res;
				}
			}
		}
	}

	//net methods
	class Net {
		constructor(radius, via, gap, terms, pcb, name, options = {}) {
			this.m_pcb = pcb;
			this.m_name = name;
			this.m_priority = options.priority || 0;
			this.m_fixed = [];
			this.m_routed = false;
			this.m_radius = radius * pcb.m_resolution;
			this.m_via = via * pcb.m_resolution;
			this.m_gap = gap * pcb.m_resolution;
			this.m_terminals = terms;
			this.m_paths = [];
			scale_terminals(this.m_terminals, pcb.m_resolution);
			[this.m_area, this.m_bbox] = aabb_terminals(this.m_terminals, pcb.m_quantization);
			this.remove();
			for (let term of this.m_terminals) {
				for (let z = 0; z < pcb.m_depth; ++z) {
					let p = [Math.trunc(term[2][0] + 0.5), Math.trunc(term[2][1] + 0.5), z];
					let sp = [term[2][0], term[2][1], z];
					pcb.m_deform.set(p.toString(), sp);
				}
			}
		}

		//randomize order of terminals
		shuffle_topology() {
			shuffle(this.m_terminals, this.m_pcb.random);
		}

		//add terminal entries to spacial cache
		add_terminal_collision_lines() {
			let depth = this.m_pcb.m_depth;
			for (let node of this.m_terminals) {
				let g, x, y;
				[, g, [x, y, ,]] = node;
				let layers = terminal_collision_layers(node, depth);
				for (let z of layers) {
					let layer_shape = terminal_layer_shape(node, z);
					let r = layer_shape ? layer_shape.r : node[0];
					let shape = layer_shape ? layer_shape.points : node[3];
					if (!shape.length) {
						this.m_pcb.m_layers.add_line([x, y, z], [x, y, z], r, g);
					} else {
						let p1 = [x + shape[0][0], y + shape[0][1], z];
						for (let i = 1; i < shape.length; ++i) {
							let p0 = p1;
							p1 = [x + shape[i][0], y + shape[i][1], z];
							this.m_pcb.m_layers.add_line(p0, p1, r, g);
						}
					}
				}
			}
		}

		//remove terminal entries from spacial cache
		sub_terminal_collision_lines() {
			let depth = this.m_pcb.m_depth;
			for (let node of this.m_terminals) {
				let g, x, y;
				[, g, [x, y, ,]] = node;
				let layers = terminal_collision_layers(node, depth);
				for (let z of layers) {
					let layer_shape = terminal_layer_shape(node, z);
					let r = layer_shape ? layer_shape.r : node[0];
					let shape = layer_shape ? layer_shape.points : node[3];
					if (!shape.length) {
						this.m_pcb.m_layers.sub_line([x, y, z], [x, y, z], r, g);
					} else {
						let p1 = [x + shape[0][0], y + shape[0][1], z];
						for (let i = 1; i < shape.length; ++i) {
							let p0 = p1;
							p1 = [x + shape[i][0], y + shape[i][1], z];
							this.m_pcb.m_layers.sub_line(p0, p1, r, g);
						}
					}
				}
			}
		}

		//add paths entries to spacial cache
		add_paths_collision_lines() {
			for (let path of this.m_paths) {
				let p1 = this.m_pcb.grid_to_space_point(path[0]);
				for (let i = 1; i < path.length; ++i) {
					let p0 = p1;
					p1 = this.m_pcb.grid_to_space_point(path[i]);
					if (path[i - 1][2] !== path[i][2]) this.m_pcb.m_layers.add_line(p0, p1, this.m_via, this.m_gap);
					else this.m_pcb.m_layers.add_line(p0, p1, this.m_radius, this.m_gap);
				}
			}
		}

		//remove paths entries from spacial cache
		sub_paths_collision_lines() {
			for (let path of this.m_paths) {
				let p1 = this.m_pcb.grid_to_space_point(path[0]);
				for (let i = 1; i < path.length; ++i) {
					let p0 = p1;
					p1 = this.m_pcb.grid_to_space_point(path[i]);
					if (path[i - 1][2] !== path[i][2]) this.m_pcb.m_layers.sub_line(p0, p1, this.m_via, this.m_gap);
					else this.m_pcb.m_layers.sub_line(p0, p1, this.m_radius, this.m_gap);
				}
			}
		}

		//remove net entries from spacial grid
		remove() {
			this.sub_paths_collision_lines();
			this.sub_terminal_collision_lines();
			this.m_paths = [];
			this.m_routed = false;
			this.add_terminal_collision_lines();
		}

		//remove redundant points from paths
		optimise_paths(paths) {
			let opt_paths = [];
			for (let path of paths) {
				let opt_path = [];
				let d = [0.0, 0.0, 0.0];
				let p1 = this.m_pcb.grid_to_space_point(path[0]);
				for (let i = 1; i < path.length; ++i) {
					let p0 = p1;
					p1 = this.m_pcb.grid_to_space_point(path[i]);
					let d1 = js_pcb.norm_3d(js_pcb.sub_3d(p1, p0));
					if (!js_pcb.equal_3d(d1, d)) {
						opt_path.push(path[i - 1]);
						d = d1;
					}
				}
				opt_path.push(path[path.length - 1]);
				opt_paths.push(opt_path);
			}
			return opt_paths;
		}

		//backtrack path from ends to starts
		backtrack_path(visited, end_node, radius, via, gap) {
			let via_vectors = this.m_pcb.m_via_vectors;
			let path = [];
			let path_node = end_node;
			let steps = 0;
			for (;;) {
				if ((steps++ & 0x3ff) === 0 && this.m_pcb.expired()) {
					this.m_pcb.m_timedout = true;
					return [[], false];
				}
				path.push(path_node);
				let nearer_nodes = [];
				for (let node of this.m_pcb.all_not_shorting(
					this.m_pcb.all_nearer_sorted(this.m_pcb.m_routing_path_vectors, path_node, this.m_pcb.m_dfunc),
					path_node,
					radius,
					gap,
				)) {
					nearer_nodes.push(node);
				}
				for (let node of this.m_pcb.all_not_shorting(
					this.m_pcb.all_nearer_sorted(via_vectors, path_node, this.m_pcb.m_dfunc),
					path_node,
					via,
					gap,
				)) {
					nearer_nodes.push(node);
				}
				if (!nearer_nodes.length) return [[], false];
				let search = nearer_nodes.find(function (node) {
					return visited.has(node);
				});
				if (search !== undefined) {
					//found existing track
					path.push(search);
					return [path, true];
				}
				path_node = nearer_nodes[0];
			}
		}

		fixed_collision(fixed, add) {
			const method = add ? 'add_line' : 'sub_line';
			for (let i = 1; i < fixed.points.length; i++) {
				const radius = fixed.points[i - 1][2] === fixed.points[i][2] ? fixed.radius : this.m_via;
				this.m_pcb.m_layers[method](fixed.points[i - 1], fixed.points[i], radius, this.m_gap);
			}
		}

		route_fixed() {
			return routeFixed(this, NodeSet, terminal_connect_layers);
		}

		//attempt to route this net on the current boards state
		route() {
			//check for unused terminals track
			if (this.m_radius === 0.0) return true;
			this.m_paths = [];
			this.m_routed = false;
			if (this.m_fixed.length) return this.route_fixed();
			this.sub_terminal_collision_lines();
			let visited = new NodeSet(undefined, this.m_pcb.m_node_key);
			for (let index = 1; index < this.m_terminals.length; ++index) {
				// 单个多引脚网络可能需要很久，这里按引脚对检查超时，避免外层循环被长时间卡住。
				if (this.m_pcb.expired()) {
					this.m_pcb.m_timedout = true;
					this.remove();
					return false;
				}
				let ends = [];
				// 目标焊盘只在其实际存在的层上可达；缺少层信息时拒绝布线，
				// 而不是退化为“所有层都可连接”。
				let target_layers = terminal_connect_layers(this.m_terminals[index]);
				let start_layers = terminal_connect_layers(this.m_terminals[index - 1]);
				if (!target_layers.length || !start_layers.length) {
					if (!this.m_layerErrorLogged) {
						this.m_layerErrorLogged = true;
						this.m_pcb.notify({
							type: 'log',
							key: 'log.padLayerMissing',
							args: [this.m_terminals.length],
						});
					}
					this.remove();
					return false;
				}
				for (let z of target_layers) {
					let x = Math.trunc(this.m_terminals[index][2][0] + 0.5);
					let y = Math.trunc(this.m_terminals[index][2][1] + 0.5);
					ends.push([x, y, z]);
				}
				let search = ends.find(function (node) {
					return visited.has(node);
				});
				if (search !== undefined) continue;
				// 起点焊盘同理：只在它自己的层上作为搜索起点
				for (let z of start_layers) {
					let x = Math.trunc(this.m_terminals[index - 1][2][0] + 0.5);
					let y = Math.trunc(this.m_terminals[index - 1][2][1] + 0.5);
					visited.add([x, y, z]);
				}
				let filled = this.m_pcb.mark_distances(this.m_pcb.m_routing_flood_vectors, this.m_radius, this.m_via, this.m_gap, visited, ends);
				if (!filled) {
					this.m_pcb.m_timedout = true;
					this.m_pcb.unmark_distances();
					this.remove();
					return false;
				}
				let sorted_ends = [];
				for (let node of ends) sorted_ends.push([this.m_pcb.get_node(node), node]);
				sorted_ends.sort(function (s1, s2) {
					return s1[0] - s2[0];
				});
				let result = this.backtrack_path(visited, sorted_ends[0][1], this.m_radius, this.m_via, this.m_gap);
				this.m_pcb.unmark_distances();
				if (!result[1]) {
					if (this.m_pcb.expired()) this.m_pcb.m_timedout = true;
					this.remove();
					return false;
				}
				for (let node of result[0]) visited.add(node);
				this.m_paths.push(result[0]);
			}
			this.m_paths = this.optimise_paths(this.m_paths);
			this.add_paths_collision_lines();
			this.add_terminal_collision_lines();
			this.m_routed = true;
			return true;
		}

		//output net, terminals and paths, for viewer app
		output_net() {
			let pcb = this.m_pcb;
			let gsp = this.m_pcb.grid_to_space_point;
			let scale = 1.0 / this.m_pcb.m_resolution;
			let track = [];
			track.push(this.m_radius * scale);
			track.push(this.m_via * scale);
			track.push(this.m_gap * scale);
			track.push(
				this.m_terminals.map(function (t) {
					// 第 5 项保留焊盘所在层，供预览区分顶层/底层/通孔焊盘
					return [
						t[0] * scale,
						t[1] * scale,
						[t[2][0] * scale, t[2][1] * scale, t[2][2]],
						t[3].map(function (n) {
							return [n[0] * scale, n[1] * scale];
						}),
						t[4] || [],
					];
				}),
			);
			track.push(
				this.m_paths.map(function (path) {
					return path.map(function (n) {
						let p = gsp.call(pcb, n);
						return [p[0] * scale, p[1] * scale, p[2]];
					});
				}),
			);
			track.push(this.m_name);
			track.push({ routed: this.m_routed });
			return track;
		}
	}

	js_pcb.Pcb = Pcb;
})();

module.exports = js_pcb;
