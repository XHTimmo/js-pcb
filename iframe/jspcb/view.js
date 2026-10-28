'use strict';

var js_pcb = js_pcb || {};
(function () {
	function view_pcb(pcb_data, scale, margin, boundary) {
		//Width and height etc
		let width, height, depth;
		[width, height, depth] = pcb_data[0];

		//create/replace SVG element
		let container = d3.select('#pcb_view');
		if (container.empty()) container = d3.select('body');

		// Auto-scaling logic
		if (scale <= 0) {
			// Get container dimensions
			let containerNode = container.node();
			let cw = containerNode.clientWidth || 800;
			let ch = containerNode.clientHeight || 600;

			// Calculate scale to fit
			// PCB size in units: width, height
			// We want (width * scale) <= cw and (height * scale) <= ch
			// We also need to account for margin * scale * 2
			// total_w = (width + margin * 2) * scale
			// total_h = (height + margin * 2) * scale

			let w_scale = cw / (width + margin * 2);
			let h_scale = ch / (height + margin * 2);

			scale = Math.min(w_scale, h_scale);

			// Optional: Limit max scale or min scale if needed
			if (scale <= 0) scale = 1;
		}

		let path_func = d3
			.line()
			.x(function (d) {
				return d[0];
			})
			.y(function (d) {
				return d[1];
			});

		let svg = container.select('svg');
		if (!svg.empty()) svg.remove();
		svg = container
			.append('svg')
			.attr('width', (width + margin * 2) * scale)
			.attr('height', (height + margin * 2) * scale)
			.style('display', 'block') // Remove extra space below SVG
			.style('margin', 'auto'); // Center horizontally if flex doesn't cover it

		svg.append('rect')
			.attr('width', (width + margin * 2) * scale)
			.attr('height', (height + margin * 2) * scale)
			.attr('fill', 'black');

		let pcb = svg
			.append('g')
			.attr('transform', 'scale(' + scale + ',' + scale + ') translate(' + margin + ',' + margin + ')')
			.attr('stroke-linecap', 'round')
			.attr('stroke-linejoin', 'round')
			.attr('stroke-width', '0')
			.attr('fill', 'none');

		//create layers, last layer is the terminals layer
		let layers = [];
		let layer_colors = ['#ff9a9a', '#8ec5ff', '#facc15', '#c7ccd4', '#f472b6', '#a78bfa'];
		for (let layer = 0; layer < depth; ++layer) {
			layers.push(
				pcb
					.append('g')
					.attr('stroke', layer_colors[layer % layer_colors.length])
					.attr('stroke-opacity', 0.9),
			);
		}
		layers.push(pcb.append('g').attr('stroke', '#c7ccd4'));

		//add tracks
		for (let track of pcb_data[1]) {
			let track_radius, paths;
			[track_radius, , , , paths] = track;
			for (let path of paths) {
				let node,
					start = 0;
				let d = path[start][2];
				for (node = 1; node < path.length; ++node) {
					if (path[node][2] === d) continue;
					if (node - start > 1) {
						layers[d]
							.append('path')
							.attr('stroke-width', track_radius * 2)
							.attr('d', path_func(path.slice(start, node)));
					}
					start = node;
					d = path[start][2];
				}
				if (node - start > 1) {
					layers[d]
						.append('path')
						.attr('stroke-width', track_radius * 2)
						.attr('d', path_func(path.slice(start, node)));
				}
			}
		}

		//add terminals and vias
		for (let track of pcb_data[1]) {
			let track_radius, via_radius, track_gap, terminals, paths;
			[track_radius, via_radius, track_gap, terminals, paths] = track;
			for (let terminal of terminals) {
				let terminal_radius, terminal_gap, terminal_x, terminal_y, terminal_z, terminal_shape;
				[terminal_radius, terminal_gap, [terminal_x, terminal_y, terminal_z], terminal_shape] = terminal;
				// 按焊盘层着色：顶层淡红色、底层淡蓝色、通孔（多层）淡灰色
				let terminal_layers = terminal[4] || [];
				let terminal_color = '#c7ccd4';
				if (terminal_layers.length === 1) {
					if (terminal_layers[0] === 0) terminal_color = '#ff9a9a';
					else if (terminal_layers[0] === 1) terminal_color = '#8ec5ff';
				}
				if (!terminal_shape.length) {
					layers[layers.length - 1]
						.append('circle')
						.attr('cx', terminal_x)
						.attr('cy', terminal_y)
						.attr('r', terminal_radius)
						.attr('fill', terminal_color);
				} else if (terminal_shape.length === 2) {
					layers[layers.length - 1]
						.append('path')
						.attr('stroke', terminal_color)
						.attr('stroke-width', terminal_radius * 2)
						.attr(
							'd',
							path_func(
								terminal_shape.map(function (e) {
									return [e[0] + terminal_x, e[1] + terminal_y];
								}),
							),
						);
				} else {
					layers[layers.length - 1]
						.append('path')
						.attr('fill', terminal_color)
						.attr(
							'd',
							path_func(
								terminal_shape.map(function (e) {
									return [e[0] + terminal_x, e[1] + terminal_y];
								}),
							),
						);
				}
			}
			for (let path of paths) {
				let terminal_z = path[0][2];
				for (let node = 1; node < path.length; ++node) {
					if (terminal_z !== path[node][2]) {
						layers[layers.length - 1]
							.append('circle')
							.attr('cx', path[node][0])
							.attr('cy', path[node][1])
							.attr('r', via_radius)
							.attr('fill', '#c7ccd4');
					}
					terminal_z = path[node][2];
				}
			}
		}

		//draw board outline (板框)
		if (boundary && boundary.length) {
			// 兼容单个 path（旧格式）和多个 path（外框 + 挖槽）
			let outlines = Array.isArray(boundary[0]) && boundary[0].length && Array.isArray(boundary[0][0]) ? boundary : [boundary];
			for (let outline of outlines) {
				if (!outline || outline.length < 2) continue;
				let closed = outline.concat([outline[0]]);
				pcb.append('path')
					.attr('d', path_func(closed) + 'Z')
					.attr('stroke', '#facc15')
					.attr('stroke-width', 1.2 / scale)
					.attr('stroke-opacity', 0.9)
					.attr('stroke-linejoin', 'round')
					.attr('fill', 'none');
			}
		}
	}

	js_pcb.view_pcb = view_pcb;
})();
