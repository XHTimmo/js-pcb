importScripts('mymath.js', 'layer.js', 'router.js');

function pcb_stats(pcb_data)
{
	let total = 0;
	let unrouted = 0;
	let tracks = (pcb_data && pcb_data[1]) ? pcb_data[1] : [];
	for (let track of tracks)
	{
		if (!(track[0] > 0)) continue; // 无电气连接的虚拟网络
		total++;
		if (!track[4] || track[4].length === 0) unrouted++;
	}
	return { total: total, unrouted: unrouted, routed: total - unrouted };
}

function pcb_thread(paramater_array)
{
	//generate range of routing vectors
	function gen_vectors(vec_range, x_range, y_range)
	{
		let v = [];
		for (let y = y_range; y >= -y_range; --y)
		{
			for (let x = x_range; x >= -x_range; --x)
			{
				let p = [x, y];
				if (js_pcb.length_2d(p) > 0.1 && js_pcb.length_2d(p) <= vec_range)
				{
					v.push([x, y, 0]);
				}
			}
		}
		return v;
	}

	//args
	let pcb_data, arg_t, arg_v, arg_s, arg_z, arg_r, arg_q, arg_d, arg_fr, arg_xr, arg_yr;
	[pcb_data, arg_t, arg_v, arg_s, arg_z, arg_r, arg_q, arg_d, arg_fr, arg_xr, arg_yr] = paramater_array;

	//create flooding and backtracking vectors
	let flood_range = arg_fr;
	let flood_range_x_even_layer = arg_xr;
	let flood_range_y_odd_layer = arg_yr;
	let path_range = flood_range + 0;
	let path_range_x_even_layer = flood_range_x_even_layer + 0;
	let path_range_y_odd_layer = flood_range_y_odd_layer + 0;

	let routing_flood_vectorss =
			[gen_vectors(flood_range, flood_range_x_even_layer, flood_range),
			gen_vectors(flood_range, flood_range, flood_range_y_odd_layer)];

	let routing_path_vectorss =
			[gen_vectors(path_range, path_range_x_even_layer, path_range),
			gen_vectors(path_range, path_range, path_range_y_odd_layer)];

	//choose distance metric function
	let dfuncs = [js_pcb.squared_euclidean_distance_3d,
				js_pcb.manhattan_distance_3d,
				js_pcb.euclidean_distance_3d,
				js_pcb.chebyshev_distance_3d,
				js_pcb.reciprical_distance_3d];

	//create pcb object and populate with tracks from input
	let current_pcb = new js_pcb.Pcb(pcb_data[0], routing_flood_vectorss, routing_path_vectorss,
					dfuncs[arg_d], arg_r, arg_v, arg_q, arg_z);
	for (let track of pcb_data[1]) current_pcb.add_track(track);
	// 板框作为墙壁，避免走线/过孔贴边或越界（DRC 板边间距）
	if (pcb_data[2] && pcb_data[2].length) current_pcb.add_wall(pcb_data[2], pcb_data[3] || 0);

	const total_connected = current_pcb.connected_nets();
	postMessage({type: 'progress', done: 0, total: total_connected});
	postMessage({
		type: 'log',
		key: 'log.routingStart',
		args: [total_connected, arg_s, arg_t]
	});

	//run number of samples of solution and pick best one
	let best_pcb = current_pcb.output_pcb();
	postMessage(best_pcb);
	let best_cost = Infinity;
	let timed_out = false;
	for (let i = 0; i < arg_s; ++i)
	{
		// 发送日志消息
		postMessage({
			type: 'log',
			key: 'log.sampleStart',
			args: [i + 1, arg_s]
		});

		let startTime = Date.now();
		if (!current_pcb.route(arg_t))
		{
			if (current_pcb.m_timedout)
			{
				timed_out = true;
				// 已到超时时间：保留目前的最佳结果并结束，避免无限等待。
				let routed_cost = current_pcb.cost();
				if (routed_cost < best_cost)
				{
					best_cost = routed_cost;
					best_pcb = current_pcb.output_pcb();
				}
				postMessage({
					type: 'log',
					key: 'log.timeout',
					args: [i + 1, arg_s, arg_t]
				});
				break;
			}
			current_pcb.increase_quantization();
			postMessage({
				type: 'log',
				key: 'log.sampleFail',
				args: [i + 1, arg_s]
			});
			continue;
		}
		
		let endTime = Date.now();
		let duration = (endTime - startTime) / 1000;
		let cost = current_pcb.cost();
		
		const sample_total = current_pcb.connected_nets();
		const sample_unrouted = current_pcb.unrouted_nets();
		postMessage({
			type: 'log',
			key: 'log.sampleDone',
			args: [i + 1, arg_s, duration.toFixed(2), sample_total - sample_unrouted, sample_total, cost]
		});

		if (cost <= best_cost)
		{
			best_cost = cost;
			best_pcb = current_pcb.output_pcb();
			postMessage({
				type: 'log', 
				key: 'log.better',
				args: [cost]
			});
			// Send intermediate best result for visualization
			postMessage(best_pcb);
		}
	}
	
	// 统计必须与最终返回的 best_pcb 一致，而不是最后一次采样的 current_pcb
	const stats = pcb_stats(best_pcb);
	let status = 'complete';
	if (stats.unrouted > 0) status = timed_out ? 'timeout' : 'partial';

	postMessage({type: 'progress', done: stats.routed, total: stats.total});
	postMessage({
		type: 'log',
		key: 'log.allDone',
		args: [stats.routed, stats.total, stats.unrouted]
	});
	postMessage({
		type: 'done',
		data: best_pcb,
		cost: best_cost,
		unrouted: stats.unrouted,
		total: stats.total,
		status: status
	});
}

//thread event listner
addEventListener('message', function(event)
{
	try
	{
		pcb_thread(event.data);
	}
	catch (e)
	{
		// 把异常回传给主线程，否则 worker 内报错时界面只会一直停住。
		postMessage({
			type: 'error',
			message: (e && e.stack) ? e.stack : String(e)
		});
	}
}, false);
