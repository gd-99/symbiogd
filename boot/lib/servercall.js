(function() {
	/**
	 * A server call.
	 * @augments {Webos.Operation}
	 * @since  1.0alpha1
	 */
	Webos.ServerCall = function () {
		Webos.Operation.call(this);

		this._initialize.apply(this, arguments);
	};
	Webos.ServerCall.prototype = {
		/**
		 * This server call's id.
		 * @type {Number}
		 * @private
		 */
		_id: null,
		/**
		 * Options for this server call.
		 * @type {Object}
		 * @private
		 */
		_options: {},
		/**
		 * This server call's request URL.
		 * @type {String}
		 * @private
		 */
		_url: 'sbin/apicall.php',
		/**
		 * This server call's request data.
		 * @type {Object}
		 * @private
		 */
		_data: {},
		/**
		 * This server call's request type.
		 * @type {String}
		 * @private
		 */
		_type: 'post',
		/**
		 * This server call's status. 0 means not sent, 1 means pending and 2 means completed.
		 * @type {Number}
		 * @private
		 */
		_status: 0,
		/**
		 * The number of attempts to execute this server call, in case of HTTP error.
		 * @type {Number}
		 * @private
		 */
		_nbrAttempts: 0,
		/**
		 * Initialize this server call.
		 * @param {Object} options An object containing options.
		 * @param {String} options.class The class' name.
		 * @param {String} options.method The method's name.
		 * @param {Object} [options.arguments] Arguments to provide to the method.
		 * @param {String} [options.username] The username with which the method will be called.
		 * @param {String} [options.password] The password corresponding to the username.
		 * @param {Number} [options.pid] The process' ID with which the method will be called.
		 * @param {String} [options.key] The process' key.
		 * @constructor
		 * @private
		 */
		_initialize: function (opts) {
			//Default options
			var defaults = {
				'class': '',
				method: '',
				arguments: {},
				host: '',
				username: '',
				password: '',
				pid: '',
				key: '',
				transports: {
					skip: []
				}
			};

			if (Webos.Process) {
				var currProcess = Webos.Process.current();
				if (currProcess) {
					defaults.pid = currProcess.getPid();
				}
			}

			var options = $.extend({}, defaults, opts);

			if (options.host) { //If host is specified, do not use the websocket connection
				options.transports.skip.push('websocket');
			}

			this._options = options;

			var module = options['class'].replace(/Controller$/, '');
			module = module.charAt(0).toLowerCase() + module.substr(1);

			this._id = Webos.ServerCall.addCallToList(this);

			this._data = {
				id: this.id(),
				module: module,
				action: options.method,
				arguments: encodeURIComponent(JSON.stringify(options.arguments, function(key, value) { //Convert all arguments to strings/numbers
					if (typeof value === 'number' && !isFinite(value)) {
						return String(value);
					}
					return value;
				})),
				user: options.username,
				password: options.password,
				pid: options.pid,
				key: options.key
			};

			this._status = 0;
			this._nbrAttempts = 0;
		},
		acceptedTransports: function () {
			var transports = Webos.ServerCall.transportsForCall(this);

			var skipped = this._options.transports.skip;
			if (skipped && skipped instanceof Array) {
				for (var i = 0; i < skipped.length; i++) {
					var transName = skipped[i];

					if (transports[transName]) {
						delete transports[transName];
					}
				}
			}

			return transports;
		},
		_transport: function () {
			var transports = this.acceptedTransports();

			for (var transName in transports) {
				usedTransportName = transName;
				break;
			}

			return usedTransportName;
		},
		/**
		 * Load this server call.
		 * @private
		 */
		_load: function () {
			var that = this;

			var transports = this.acceptedTransports(),
				usedTransportName = this._transport(),
				usedTransport = transports[usedTransportName];

			if (!usedTransport) {
				var error = 'No transport available to send request';

				var response = new W.ServerCall.Response({ //On cree une reponse d'erreur, et on execute le callback d'erreur
					'success': false,
					'channels': {
						1: null,
						2: error //On ajoute le message d'erreur
					},
					'out': error
				});

				that.setCompleted(response);
				return;
			}

			usedTransport.doRequest(this, [function(json) {
				try {
					if (!json) {
						throw new Webos.Error('Empty response');
					}

					var data = jQuery.parseJSON(json); //On essaie de recuperer les donnees JSON
				} catch (jsonError) { //Si une erreur survient
					var error = 'Malformed JSON data ('+jsonError.name+'): '+jsonError.message+'. Data :'+"\n"+json;
					error += "\n"+that.stack();
					
					var response = new W.ServerCall.Response({ //On cree une reponse d'erreur, et on execute le callback d'erreur
						'success': false,
						'channels': {
							1: null,
							2: error //On ajoute le message d'erreur
						},
						'js': null,
						'out': error
					});
					
					that.setCompleted(response);
					return; //On stoppe l'execution de la fonction
				}
				
				var response = new W.ServerCall.Response(data); //On cree la reponse
				
				that.setCompleted(response);
			}, function(res) {
				//First try again
				usedTransport = Webos.ServerCall.transport(usedTransportName);
				if (that._nbrAttempts < Webos.ServerCall.options.maxAttempts && !usedTransport.disabled()) {
					setTimeout(function() {
						that.load();
					}, Webos.ServerCall.options.errorDelay);
					return;
				}

				//Then try with a different transport
				var nextTransportName = '', lastTransportName = '';
				for (var transName in transports) {
					if (lastTransportName == usedTransportName) {
						nextTransportName = transName;
						break;
					}

					lastTransportName = transName;
				}

				if (nextTransportName) {
					Webos.ServerCall.disableTransport(usedTransportName);

					that._nbrAttempts = 0;
					that.load();
					return;
				}

				//No more transport, trigger an error

				var errMsg = 'An error occurred while loading a request (no working transport found)';
				/*if (textStatus) {
					error += ' (status : '+textStatus;
					if (errorThrown) {
						error += ', '+errorThrown;
					}
					error += ')';
				}*/
				errMsg += "\n"+that.stack();

				var resp = Webos.ServerCall.Response.error(errMsg);
				that.setCompleted(resp);
			}]);
		},
		id: function () {
			return this._id;
		},
		failed: function () {
			return (this._result && !this._result.isSuccess());
		},
		result: function() {
			return this._result;
		},
		setStarted: function () {
			this._super('setStarted');

			this._status = 1;

			this._nbrAttempts++;

			if (this._nbrAttempts == 1) {
				this._startTime = new Date();

				Webos.ServerCall.callStart(this);
			}
		},
		setCompleted: function (response) {
			this._super('setCompleted', response);

			this._status = 2;
			this._completeTime = new Date();

			Webos.ServerCall.callComplete(this);
		},
		/**
		 * Load this server call.
		 * @param  {Webos.Callback} callback The callback.
		 */
		load: function $_WServerCall_load(callback) {
			var that = this;

			if (callback) {
				this.addCallbacks(callback);
			}

			this.setStarted();

			for (var i = 0; i < Webos.ServerCall.list.length; i++) {
				var call = Webos.ServerCall.list[i];
				
				if (call._status == 1 && call.id() != this.id()) {
					var isEqual = true;
					for (var attr in call._data) {
						if (call._data[attr] != this._data[attr]) {
							isEqual = false;
							break;
						}
					}

					if (isEqual) {
						call.on('complete', function() {
							that.setCompleted(call.result());
						});
						return this;
					}
				}
			}

			var transport = Webos.ServerCall.transport(this._transport());

			//Do not group this request if:
			// - request is async
			// - request is on another host
			// - transport cannot group requests
			if (this._options.async === false || this._options.host || !transport.requestsOptions.groupRequests) {
				//Webos.ServerCall._removeFromLoadStack(this);
				that._load();
			} else {
				Webos.ServerCall._addToLoadStack(this);
			}

			return this;
		},
		/**
		 * Get this server call's stack trace.
		 * @returns {String} The stack.
		 */
		stack: function $_WServerCall_stack() {
			var stack = '    at '+this._url+' calling action "'+this._data.action+'" in module "'+this._data.module+'"';
			if (this._data.arguments && this._data.arguments != '{}') {
				stack += "\n"+'    with arguments '+JSON.stringify(this._data.arguments);
			} else {
				stack += "\n"+'    without arguments';
			}
			if (this._data.user) {
				stack += "\n"+'    as '+this._data.user;
			}
			if (this._data.pid) {
				stack += "\n"+'    in process #'+this._data.pid;
			}
			return stack;
		}
	};
	Webos.inherit(Webos.ServerCall, Webos.Operation);

	/**
	 * Global options for server calls.
	 * @type {Object}
	 * @static
	 * @private
	 */
	Webos.ServerCall.options = {
		groupRequests: true,
		maxAttempts: 3,
		errorDelay: 1000
	};

	//Messages IDs
	Webos.ServerCall._lastMsgId = -1;
	Webos.ServerCall.requestMsgId = function() {
		return ++Webos.ServerCall._lastMsgId;
	};
	Webos.ServerCall.lastMsgId = function() {
		return Webos.ServerCall._lastMsgId;
	};

	//Transports
	Webos.ServerCall._transports = {};
	Webos.ServerCall.registerTransport = function(name, api) {
		Webos.ServerCall._transports[name] = $.extend({
			priority: 0,
			requestsOptions: $.extend({}, Webos.ServerCall.options),
			name: function() {
				return name;
			},
			supports: function () {
				return false;
			},
			disabled: function() {
				return Webos.ServerCall.transport(name)._disabled;
			},
			canTransport: function(req) {
				return false;
			},
			canTransportRequestGroups: function() {
				return (typeof api.doRequestGroup == 'function');
			},
			doRequest: function(req, callback) {
				var operation = new Webos.Operation();
				operation.addCallbacks(callback);

				operation.setCompleted(false);

				return operation;
			},
			doRequestGroup: function(requests, callback) {
				var operation = new Webos.Operation();
				operation.addCallbacks(callback);

				operation.setCompleted(false);

				return operation;
			}
		}, api, {
			_disabled: false
		});
	};
	Webos.ServerCall.unregisterTransport = function(name) {
		delete Webos.ServerCall._transports[name];
	};
	Webos.ServerCall.enableTransport = function(name) {
		if (typeof Webos.ServerCall._transports[name] != 'undefined') {
			Webos.ServerCall._transports[name]._disabled = false;
		}
	};
	Webos.ServerCall.disableTransport = function(name) {
		if (typeof Webos.ServerCall._transports[name] != 'undefined') {
			Webos.ServerCall._transports[name]._disabled = true;
		}
	};
	Webos.ServerCall.transports = function() {
		return Webos.ServerCall._transports;
	};
	Webos.ServerCall.transport = function(name) {
		return Webos.ServerCall.transports()[name];
	};
	Webos.ServerCall.supportedTransports = function() {
		var transports = Webos.ServerCall.transports(),
			supportedList = [];

		for (var transName in transports) {
			var transApi = transports[transName];

			if (transApi._disabled) {
				continue;
			}

			if (!transApi.supports()) {
				continue;
			}

			supportedList.push(transApi);
		}

		supportedList.sort(function(a, b) {
			return b.priority - a.priority;
		});

		var supported = {};

		for (var i = 0; i < supportedList.length; i++) {
			var trans = supportedList[i];

			supported[trans.name()] = trans;
		}

		return supported;
	};
	Webos.ServerCall.transportsForCall = function (serverCall) {
		var transports = Webos.ServerCall.supportedTransports(), supported = {};

		for (var transName in transports) {
			var transApi = transports[transName];

			if (!transApi.canTransport(serverCall)) {
				continue;
			}

			supported[transName] = transApi;
		}

		return supported;
	};

	Webos.ServerCall.ajax = {
		priority: 1,
		options: {
			url: 'sbin/apicall.php',
			group: {
				url: 'sbin/apicallgroup.php',
				type: 'post'
			}
		},
		supports: function() {
			return jQuery.support.ajax;
		},
		canTransport: function(req) {
			return true;
		},
		doRequest: function(req, callback) {
			var operation = new Webos.Operation();
			operation.addCallbacks(callback);

			var url = Webos.ServerCall.ajax.options.url;
			if (req._options.host) {
				url = req._options.host+'/'+url;
			}

			var reqData = $.extend({}, req._data, {
				id: Webos.ServerCall.requestMsgId()
			});

			$.ajax({
				url: url,
				data: reqData,
				type: req._type,
				async: (req._options.async === false) ? false : true,
				dataType: 'text',
				success: function(json, textStatus, jqXHR) { //En cas de succes
					operation.setCompleted(json);
				},
				error: function(jqXHR, textStatus, errorThrown) { //Une erreur est survenue
					operation.setCompleted(false);
				}
			});

			return operation;
		},
		doRequestGroup: function(requests, callback) {
			var operation = new Webos.Operation();
			operation.addCallbacks(callback);

			var data = [], async = true;

			for (var i = 0; i < requests.length; i++) {
				var req = requests[i];

				if (!req.started()) {
					req.setStarted();
				}
				data[i] = req._data;

				if (typeof data[i].arguments == 'string') {
					data[i].arguments = JSON.parse(decodeURIComponent(data[i].arguments));
				}

				if (async && req._options.async === false) {
					async = false;
				}
			}

			var msgId = Webos.ServerCall.requestMsgId();

			$.ajax({
				url: Webos.ServerCall.ajax.options.group.url,
				data: {
					id: msgId,
					groupped: true,
					data: JSON.stringify(data)
				},
				type: Webos.ServerCall.ajax.options.group.type,
				async: async,
				dataType: 'text',
				success: function(json, textStatus, jqXHR) { //En cas de succes
					operation.setCompleted(json);
				},
				error: function(jqXHR, textStatus, errorThrown) { //Une erreur est survenue
					var errorMsg = 'An error occurred while loading an ajax request';
					if (textStatus) {
						errorMsg += ' (status : '+textStatus;
						if (errorThrown) {
							errorMsg += ', '+errorThrown;
						}
						errorMsg += ')';
					}

					operation.setCompleted(Webos.Error.build(errorMsg));
				}
			});

			return operation;
		}
	};
	Webos.ServerCall.registerTransport('ajax', Webos.ServerCall.ajax);

	Webos.ServerCall.websocket = {
		priority: 2,
		options: {
			server: null
		},
		_socket: null,
		_lastRespId: null,
		_pendingOperations: {},
		supports: function () {
			return (typeof window.WebSocket != 'undefined');
		},
		canTransport: function(serverCall) {
			return (serverCall._options.async !== false);
		},
		socket: function() {
			return Webos.ServerCall.websocket._socket;
		},
		_pendingOperation: function(id) {
			return Webos.ServerCall.websocket._pendingOperations[id];
		},
		_lastPendingOperationId: function() {
			for (var opId in Webos.ServerCall.websocket._pendingOperations) {}
			return opId;
		},
		_pendingOperationsNbr: function() {
			var i = 0;
			for (var opId in Webos.ServerCall.websocket._pendingOperations) {
				i++;
			}
			return i;
		},
		getServerStatus: function(callback) {
			var operation = new Webos.Operation();
			operation.addCallbacks(callback);

			new Webos.ServerCall({
				'class': 'WebSocketController',
				'method': 'getServerStatus',
				transports: {
					skip: ['websocket']
				}
			}).load([function(res) {
				var serverStatus = res.getData();
				Webos.ServerCall.websocket.options.server = serverStatus;

				operation.setCompleted(serverStatus);
			}, function(res) {
				operation.setCompleted(res);
			}]);

			return operation;
		},
		startServer: function(callback) {
			console.log('Starting server...');

			var call = new Webos.ServerCall({
				'class': 'WebSocketController',
				'method': 'startServer',
				transports: {
					skip: ['websocket']
				}
			}).load();
			call.addCallbacks(callback);

			return call;
		},
		stopServer: function(callback) {
			console.log('Stopping server...');

			var call = new Webos.ServerCall({
				'class': 'WebSocketController',
				'method': 'stopServer',
				transports: {
					skip: ['websocket']
				}
			}).load();
			call.addCallbacks(callback);
			call.on('success', function() {
				Webos.ServerCall.websocket.options.server.started = false;
			});

			return call;
		},
		restartServer: function(callback) {
			console.log('Restarting server...');

			var call = new Webos.ServerCall({
				'class': 'WebSocketController',
				'method': 'restartServer',
				transports: {
					skip: ['websocket']
				}
			}).load();
			call.addCallbacks(callback);

			return call;
		},
		connect: function(callback) {
			if (Webos.ServerCall.websocket._connecting) {
				var operation = Webos.ServerCall.websocket._connectOperation;
				operation.addCallbacks(callback);

				return operation;
			}

			var operation = new Webos.Operation();
			operation.addCallbacks(callback);

			var gotServerStatus = function(serverStatus) {
				//Check server status
				if (!serverStatus.enabled) {
					Webos.ServerCall.disableTransport('websocket');
					operation.setCompleted(Webos.Error.build('WebSocket server not enabled'));
					return;
				}

				if (!serverStatus.started) {
					if (!serverStatus.autoStart) {
						Webos.ServerCall.disableTransport('websocket');
						operation.setCompleted(Webos.Error.build('WebSocket server not started'));
					} else {
						Webos.ServerCall.websocket.startServer([function() {
							Webos.ServerCall.websocket.options.server.started = true;
							connectSocket(serverStatus);
						}, function(res) {
							operation.setCompleted(res);
						}]);
					}
				} else { //Server started
					connectSocket(serverStatus);
				}
			};

			var connectSocket = function(serverStatus) {
				var websocketUrl = serverStatus.protocol+'://'+document.location.host+':'+serverStatus.port+'/api';

				console.log('Connecting WebSocket '+websocketUrl+'...');

				var socket = new WebSocket(websocketUrl);
				Webos.ServerCall.websocket._socket = socket;

				var errorHandler = function(e) {
					socket.removeEventListener('error', errorHandler);

					operation.setCompleted(Webos.Error.build('Error while connecting to WebSocket server'));
				};

				socket.addEventListener('open', function (e) {
					socket.removeEventListener('error', errorHandler);

					if (this.readyState == 1) {
						console.log('WebSocket connected !');
						operation.setCompleted(socket);
					} else {
						operation.setCompleted(Webos.Error.build('Error while connecting to WebSocket server'));
					}
				});

				socket.addEventListener('error', errorHandler);

				socket.addEventListener('message', function(e) {
					console.log('socket receive ('+e.data.length+')');

					var msg = e.data, resp = null;

					try {
						resp = $.parseJSON(msg);

						if (!resp) {
							resp = {};
							throw new Webos.Error('Empty response');
						}
					} catch(err) {
						msg = err;
					}

					if (resp.id === null && Webos.ServerCall.websocket._lastRespId !== null) {
						resp.id = Webos.ServerCall.websocket._lastRespId + 1;
					}

					if (Webos.ServerCall.websocket._lastRespId === null && Webos.ServerCall.websocket._pendingOperationsNbr() == 1) {
						resp.id = Webos.ServerCall.websocket._lastPendingOperationId();
					}

					var operation = Webos.ServerCall.websocket._pendingOperation(resp.id);

					if (operation) {
						Webos.ServerCall.websocket._lastRespId = resp.id;
						operation.setCompleted(msg);
					}
				});

				socket.addEventListener('close', function(e) {
					console.log('WebSocket closed.');
				});
			};

			if (Webos.ServerCall.websocket.options.server) {
				gotServerStatus(Webos.ServerCall.websocket.options.server);
				return operation;
			}

			Webos.ServerCall.websocket._connecting = true;
			Webos.ServerCall.websocket._connectOperation = operation;

			operation.on('complete', function(data) {
				Webos.ServerCall.websocket._connecting = false;
				Webos.ServerCall.websocket._connectOperation = null;
			});

			Webos.ServerCall.websocket.getServerStatus([function(serverStatus) {
				gotServerStatus(serverStatus);
			}, function(res) {
				operation.setCompleted(res);
			}]);

			return operation;
		},
		disconnect: function() {
			var socket = Webos.ServerCall.websocket.socket();

			if (socket) {
				socket.close();
			}

			Webos.ServerCall.websocket._socket = null;
		},
		reconnect: function(callback) {
			Webos.ServerCall.websocket.disconnect();
			return Webos.ServerCall.websocket.connect(callback);
		},
		_sendMsg: function(msg, callback) {
			var operation = new Webos.Operation();
			operation.addCallbacks(callback);

			var sendMsg = function(socket) {
				var errorHandler = function(e) {
					removeHandlers();
					operation.setCompleted(Webos.Error.build('Error while sending message to WebSocket server: '+e.toString()));
				};
				var msgHandler = function(e) {
					removeHandlers();
				};
				var removeHandlers = function() {
					socket.removeEventListener('error', errorHandler);
					socket.removeEventListener('message', msgHandler);
				};

				socket.addEventListener('error', errorHandler);
				socket.addEventListener('message', msgHandler);

				var doSendMsg = function() {
					console.log('socket send ('+msg.length+')');

					operation.trigger('send');
					Webos.ServerCall.websocket._lastReqTime = (new Date()).getTime();

					try {
						socket.send(msg);
					} catch (err) {
						removeHandlers();
						operation.setCompleted(Webos.Error.build('Error while sending message to WebSocket server: '+err.message));
						return;
					}
				};

				doSendMsg();
			};

			var socket = Webos.ServerCall.websocket.socket();

			if (!socket || socket.readyState != 1) {
				Webos.ServerCall.websocket.connect([function(socket) {
					sendMsg(socket);
				}, function(res) {
					operation.setCompleted(res);
				}]);
				return operation;
			}

			sendMsg(socket);

			return operation;
		},
		doRequest: function(req, callback) {
			var operation = new Webos.Operation();
			operation.addCallbacks(callback);

			var msg = '';

			var msgId = Webos.ServerCall.requestMsgId();
			Webos.ServerCall.websocket._pendingOperations[msgId] = operation;

			try {
				msg = JSON.stringify({
					id: msgId,
					type: req._type,
					data: req._data,
					http_headers: {
						'Accept-Language': window.navigator.language || window.navigator.userLanguage
					}
				});
			} catch (err) {
				operation.setCompleted(err);
				return operation;
			}

			Webos.ServerCall.websocket._sendMsg(msg, [function() {}, function(res) {
				operation.setCompleted(res);
			}]);

			return operation;
		},
		doRequestGroup: function(requests, callback) {
			var operation = new Webos.Operation();
			operation.addCallbacks(callback);

			var data = [];

			for (var i = 0; i < requests.length; i++) {
				var req = requests[i];

				if (!req.started()) {
					req.setStarted();
				}
				data[i] = req._data;

				if (typeof data[i].arguments == 'string') {
					data[i].arguments = JSON.parse(decodeURIComponent(data[i].arguments));
				}
			}

			var msgId = Webos.ServerCall.requestMsgId();
			Webos.ServerCall.websocket._pendingOperations[msgId] = operation;

			try {
				msg = JSON.stringify({
					id: msgId,
					groupped: true,
					type: 'post',
					data: data,
					http_headers: {
						'Accept-Language': window.navigator.language || window.navigator.userLanguage
					}
				});
			} catch (err) {
				operation.setCompleted(err);
				return operation;
			}

			Webos.ServerCall.websocket._sendMsg(msg, [function() {}, function(res) {
				operation.setCompleted(res);
			}]);

			return operation;
		}
	};
	Webos.ServerCall.registerTransport('websocket', Webos.ServerCall.websocket);

	/**
	 * A list of all server calls.
	 * @type {Array}
	 * @static
	 * @private
	 */
	Webos.ServerCall.list = []; //Liste des appels au serveur

	/**
	 * A list of server calls waiting to be loaded.
	 * @type {Array}
	 * @static
	 * @private
	 */
	Webos.ServerCall._loadStack = [];

	/**
	 * Add a server call to the list.
	 * @param {Webos.ServerCall} call The server call.
	 * @returns {Number} The server call's ID.
	 * @static
	 * @private
	 */
	Webos.ServerCall.addCallToList = function $_WServerCall_addCallToList(call) {
		var id = Webos.ServerCall.list.push(call) - 1;
		Webos.ServerCall.notify('callregister', { call: call });
		return id;
	};

	/**
	 * Notify that a server call started loading.
	 * @param {Webos.ServerCall} call The server call.
	 * @static
	 * @private
	 */
	Webos.ServerCall.callStart = function $_WServerCall_callStart(call) {
		if (Webos.ServerCall.getNbrPendingCalls() == 1) {
			Webos.ServerCall.notify('start', { list: Webos.ServerCall.list });
		}
		Webos.ServerCall.notify('callstart', { call: call });
	};

	/**
	 * Notify that a server call is completed.
	 * @param {Webos.ServerCall} call The server call.
	 * @static
	 * @private
	 */
	Webos.ServerCall.callComplete = function $_WServerCall_callComplete(call) {
		if (Webos.ServerCall.getNbrPendingCalls() == 0) {
			Webos.ServerCall.notify('complete', { list: Webos.ServerCall.list });
		}
		Webos.ServerCall.notify('callcomplete', { call: call });
	};

	/**
	 * Add a server call to the load stack.
	 * @param {Webos.ServerCall} call The server call.
	 * @static
	 * @private
	 */
	Webos.ServerCall._addToLoadStack = function $_WServerCall__addToLoadStack(call) {
		Webos.ServerCall._loadStack.push(call);

		if (Webos.ServerCall._loadStack.length == 1) {
			setTimeout(function() {
				var calls = [];
				for (var i = 0; i < Webos.ServerCall._loadStack.length; i++) {
					var call = Webos.ServerCall._loadStack[i];
					calls.push(call);
				}

				Webos.ServerCall._loadStack = [];

				var group = Webos.ServerCall.join(calls);
				group._load();
			}, 0);
		}
	};

	/**
	 * Remove a server call from the load stack.
	 * @param {Webos.ServerCall} call The server call.
	 * @static
	 * @private
	 */
	Webos.ServerCall._removeFromLoadStack = function $_WServerCall__removeFromLoadStack(callToRemove) {
		var stack = [];
		for (var i = 0; i < Webos.ServerCall._loadStack.length; i++) {
			var call = Webos.ServerCall._loadStack[i];
			if (callToRemove.id() != call.id()) {
				stack.push(call);
			}
		}
		Webos.ServerCall._loadStack = stack;
	};

	/**
	 * Get a list of all server calls.
	 * @param   {Number} [status]    Filter calls with a specific status.
	 * @returns {Webos.ServerCall[]} A list of server calls.
	 * @static
	 */
	Webos.ServerCall.getList = function $_WServerCall_getList(status) {
		var list = [];
		for (var i = 0; i < Webos.ServerCall.list.length; i++) {
			if (typeof status == 'undefined' || Webos.ServerCall.list[i]._status == status) {
				list.push(Webos.ServerCall.list[i]);
			}
		}
		return list;
	};

	/**
	 * Get a list of pending calls.
	 * @returns {Webos.ServerCall[]} A list of server calls.
	 * @static
	 */
	Webos.ServerCall.getPendingCalls = function $_WServerCall_getPendingCalls() {
		return Webos.ServerCall.getList(1);
	};

	/**
	 * Get the number of completed calls.
	 * @returns {Number} The number of completed calls.
	 * @static
	 */
	Webos.ServerCall.getCompletedCalls = function $_WServerCall_getCompletedCalls() {
		return Webos.ServerCall.getList(2);
	};

	/**
	 * Get the number of pending calls.
	 * @returns {Number} The number of pending calls.
	 * @static
	 */
	Webos.ServerCall.getNbrPendingCalls = function $_WServerCall_getNbrPendingCalls() {
		return Webos.ServerCall.getPendingCalls().length;
	};

	/**
	 * Join some server calls in a group.
	 * Server calls must be passed as arguments.
	 * @returns {Webos.ServerCall.Group} The group.
	 * @static
	 */
	Webos.ServerCall.join = function $_WServerCall_join() {
		var requests = [];
		for (var i = 0; i < arguments.length; i++) {
			var arg = arguments[i];
			if (arg instanceof Array) {
				for (var j = 0; j < arg.length; j++) {
					requests.push(arg[j]);
				}
			} else if (Webos.isInstanceOf(arg, Webos.ServerCall)) {
				requests.push(arg);
			}
		}

		return new Webos.ServerCall.Group(requests);
	};

	Webos.Observable.build(Webos.ServerCall);

	/**
	 * A group of server calls.
	 * @augments {Webos.Operation}
	 * @since 1.0beta1
	 */
	Webos.ServerCall.Group = function WServerCallGroup() {
		Webos.Operation.call(this);

		this._initialize.apply(this, arguments);
	};
	Webos.ServerCall.Group.prototype = {
		/**
		 * This server calls group's options.
		 * @type {Object}
		 */
		_options: {},
		/**
		 * This server calls group's requests.
		 * @type {Array}
		 */
		_requests: [],
		/**
		 * This server calls group's request URL.
		 * @type {String}
		 */
		_url: 'sbin/apicallgroup.php',
		/**
		 * This server calls group's request type.
		 * @type {String}
		 */
		_type: 'post',
		/**
		 * This server calls group's status.
		 * @type {Number}
		 */
		_status: 0,
		/**
		 * The number of attempts to execute this server calls group, in case of HTTP error.
		 * @type {Number}
		 */
		_nbrAttempts: 0,
		/**
		 * Initialize this server calls group.
		 * @param {Webos.ServerCall[]} requests Server calls in the group.
		 * @param {Object}             opts     Options.
		 * @constructor
		 * @private
		 */
		_initialize: function (requests, opts) {
			var defaults = {};

			this._options = $.extend({}, defaults, opts); //On definit toutes les options
			this._requests = [];
			this._status = 0;
			this._nbrAttempts = 0;

			if (requests instanceof Array) {
				for (var i = 0; i < requests.length; i++) {
					this.add(requests[i]);
				}
			}
		},
		/**
		 * Add a server call to the group.
		 * @param {Webos.ServerCall}   request  The server call.
		 * @param {Webos.Callback}     callback The callback.
		 */
		add: function(request, callback) {
			if (callback) {
				request.addCallbacks(callback);
			}

			var id = this._requests.push(request) - 1;

			return id;
		},
		acceptedTransports: function () {
			var transports = Webos.ServerCall.transportsForCall(this),
				usedTransport = null;

			var transports = {};

			for (var i = 0; i < this._requests.length; i++) {
				var req = this._requests[i];

				var reqTransports = req.acceptedTransports();

				for (var transName in reqTransports) {
					var transApi = reqTransports[transName];

					if (!transApi.canTransportRequestGroups()) { //Supports request groups ?
						continue;
					}

					if (!transports[transName]) {
						transports[transName] = [i];
					} else {
						transports[transName].push(i);
					}
				}
			}

			var reqsNbr = this._requests.length,
				usedTransportsList = [];

			for (var transName in transports) {
				var reqsIndexes = transports[transName],
					transApi = Webos.ServerCall.transport(transName);

				if (reqsNbr == reqsIndexes.length) {
					usedTransportsList.push(transApi);
				}
			}

			usedTransportsList.sort(function(a, b) {
				return b.priority - a.priority;
			});

			var usedTransports = {};

			for (var i = 0; i < usedTransportsList.length; i++) {
				var trans = usedTransportsList[i];

				usedTransports[trans.name()] = trans;
			}

			return usedTransports;
		},
		_transport: function () {
			var transports = this.acceptedTransports(),
				usedTransport = null;

			for (var transName in transports) {
				usedTransportName = transName;
				break;
			}

			return usedTransportName;
		},
		/**
		 * Load all server calls in the group.
		 * @private
		 */
		_load: function() {
			var that = this, reqs = this._requests;

			if (reqs.length == 1) {
				var req = reqs[0];

				req.on('success', function(data) {
					that.setCompleted([data.result]);
				});
				req.on('error', function(data) {
					that.setCompleted(data.result);
				});
				req._load();
			} else {
				var transports = this.acceptedTransports(),
					usedTransportName = this._transport(),
					usedTransport = transports[usedTransportName];

				if (!usedTransport) {
					var errMsg = 'No transport available to send request';
					var resp = Webos.ServerCall.Response.error(errMsg);

					for (var i in reqs) {
						reqs[i].setCompleted(resp);
					}
					that.setCompleted(resp);
					return;
				}

				usedTransport.doRequestGroup(reqs, [function(json) {
					try {
						if (!json) {
							throw new Webos.Error('Empty response');
						}

						var data = jQuery.parseJSON(json); //On essaie de recuperer les donnees JSON
					} catch (jsonError) { //Si une erreur survient
						var errMsg = 'Malformed JSON data ('+jsonError.name+'): '+jsonError.message+'. Data :'+"\n"+json,
							resp;

						for (var i in reqs) {
							resp = Webos.ServerCall.Response.error(errMsg + "\n" + reqs[i].stack());
							reqs[i].setCompleted(resp);
						}
						resp = Webos.ServerCall.Response.error(errMsg);
						that.setCompleted(resp);

						return; //On stoppe l'execution de la fonction
					}
					
					var resp, i = 0;
					for (var index in data.data) {
						resp = new W.ServerCall.Response(data.data[index]); //On cree la reponse
						reqs[i].setCompleted(resp);

						i++;
					}
					that.setCompleted(data);
				}, function(res) {
					//First try again
					usedTransport = Webos.ServerCall.transport(usedTransportName);
					if (that._nbrAttempts < Webos.ServerCall.options.maxAttempts && !usedTransport.disabled()) {
						setTimeout(function() {
							that.load();
						}, Webos.ServerCall.options.errorDelay);
						return;
					}

					//Then try with a different transport
					var nextTransportName = '', lastTransportName = '';
					for (var transName in transports) {
						if (lastTransportName == usedTransportName) {
							nextTransportName = transName;
							break;
						}

						lastTransportName = transName;
					}

					if (nextTransportName) {
						Webos.ServerCall.disableTransport(usedTransportName);

						that._nbrAttempts = 0;
						that.load();
						return;
					}

					//No more transport, trigger an error

					var errMsg = 'An error occurred while loading a request group (no working transport found)',
						resp;

					for (var i in reqs) {
						resp = Webos.ServerCall.Response.error(errMsg + "\n" + reqs[i].stack());
						reqs[i].setCompleted(resp);
					}
					resp = Webos.ServerCall.Response.error(errMsg);
					that.setCompleted(resp);
				}]);
			}
		},
		/**
		 * Load all server calls in the group.
		 * @param  {Webos.Callback[]|Webos.Callback} callback The callback.
		 */
		load: function(callback) {
			if (callback) {
				if (callback instanceof Array && callback.length == this._requests.length) {
					for (var i = 0; i < this._requests.length; i++) {
						this._requests[i].addCallbacks(this._callbacks[i]);
					}
				} else {
					callback = Webos.Callback.toCallback(callback);
					for (var i = 0; i < this._requests.length; i++) {
						this._requests[i].addCallbacks(callback);
					}
				}
			}

			this.setStarted();

			this._load(callback);

			return this;
		},
		failed: function () {
			return false;
		},
		setStarted: function () {
			this._super('setStarted');

			this._status = 1;

			this._nbrAttempts++;

			if (this._nbrAttempts == 1) {
				this._startTime = new Date();
			}
		},
		setCompleted: function (result) {
			this._super('setCompleted', result);

			this._status = 2;
			this._completeTime = new Date();
		}
	};
	Webos.inherit(Webos.ServerCall.Group, Webos.Operation);


	/**
	 * A server response.
	 * @param {Object} response The response data.
	 * @constructor
	 * @since  1.0alpha1
	 */
	Webos.ServerCall.Response = function WServerCallResponse(response) {
		if (!response || typeof response != 'object') {
			response = {
				success: false,
				statusCode: 500,
				channels: {
					1: (response || null)
				},
				out: (response || null),
				data: {}
			};
		}

		response = $.extend({
			channels: {},
			out: '',
			data: {}
		}, response);

		if (typeof response.success != 'boolean' && typeof response.statusCode == 'number') { //2xx status ?
			response.success = (String(response.statusCode).substr(0, 1) == 2) ? true : false;
		}
		if (typeof response.statusCode != 'number' && typeof response.success == 'boolean') {
			response.statusCode = (response.success) ? 200 : 500;
		}

		Webos.Callback.Result.call(this, response);
	};
	Webos.ServerCall.Response.prototype = {
		/**
		 * Get a channel's content.
		 * @param  {Number} channel The channel number.
		 * @returns {String}         The channel's content.
		 */
		getChannel: function(channel) {
			return this._data.channels[channel] || '';
		},
		/**
		 * Get the standard channel's content.
		 * @returns {String} The channel's content.
		 */
		getStandardChannel: function() {
			return this.getChannel(1);
		},
		/**
		 * Get the errors' channel's content.
		 * @returns {String} The channel's content.
		 */
		getErrorsChannel: function() {
			return this.getChannel(2);
		},
		/**
		 * Get all channel's content.
		 * @returns {String} The channels' content.
		 */
		getAllChannels: function() {
			return this._data.out || '';
		},
		/**
		 * Get this status code.
		 * @return {Number} The status code.
		 */
		getStatusCode: function() {
			return this._data.statusCode;
		},
		/**
		 * Get this status class.
		 * @return {Number} The status class.
		 */
		getStatusClass: function() {
			return parseInt(String(this._data.statusCode).substr(0, 1));
		},
		/**
		 * Get the response's error, if there is one.
		 * @param  {String} [msg] An error message can be provided.
		 * @returns {Webos.Error}  The error.
		 */
		getError: function(msg) {
			if (this.isSuccess()) {
				return;
			}
			msg = (!msg) ? ((!this.getErrorsChannel()) ? this.getAllChannels() : this.getErrorsChannel()) : msg;

			var details = null;
			if (msg != this.getAllChannels()) {
				details = this.getAllChannels();
			}

			return Webos.Error.build(msg, details, this.getStatusCode());
		},
		toString: function() {
			return (this.getAllChannels() !== null) ? this.getAllChannels() : '';
		}
	};

	Webos.inherit(Webos.ServerCall.Response, Webos.Callback.Result);

	Webos.ServerCall.Response.error = function(msg) {
		return new Webos.Callback.Result({
			success: false,
			channels: {
				2: msg
			},
			out: msg
		});
	};
})();