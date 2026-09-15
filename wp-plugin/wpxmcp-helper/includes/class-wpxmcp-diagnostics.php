<?php
/**
 * Error log, cache purge, security posture and backup detection.
 *
 * @package wpxmcp
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Error log, cache purge, security posture and backup detection.
 */
class WPXMCP_Diagnostics {

	/**
	 * Singleton.
	 *
	 * @var WPXMCP_Diagnostics|null
	 */
	private static $instance = null;

	/**
	 * Most log lines one request may tail.
	 */
	const MAX_LINES = 2000;

	/**
	 * Most bytes read backwards from the end of a log, so one enormous line
	 * cannot turn a tail into a full read.
	 */
	const MAX_SCAN_BYTES = 8388608;

	/**
	 * Response budget for the log route.
	 */
	const MAX_RESPONSE_BYTES = 200000;

	/**
	 * Option holding the last fatal error. Never autoloaded.
	 */
	const FATAL_OPTION = 'wpxmcp_last_fatal';

	/**
	 * Whether a fatal has already been recorded during this request.
	 *
	 * @var bool
	 */
	private static $fatal_recorded = false;

	/**
	 * Accessor.
	 *
	 * @return WPXMCP_Diagnostics
	 */
	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Hook up.
	 */
	private function __construct() {
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );
		// Cheap: runs error_get_last() once at shutdown and writes only after a fatal.
		register_shutdown_function( array( __CLASS__, 'on_shutdown' ) );
	}

	/**
	 * Registered as soon as this file is loaded, so a fatal raised by a plugin
	 * loaded after this one is still caught. WordPress's own fatal handler ends
	 * the request with wp_die(), which stops later shutdown functions from
	 * running — this filter fires before that happens.
	 */
	public static function early_hooks() {
		add_filter( 'wp_should_handle_php_error', array( __CLASS__, 'filter_should_handle' ), 1, 2 );
	}

	/**
	 * Records the fatal WordPress is about to handle, leaving its decision alone.
	 *
	 * @param bool  $should_handle WordPress's decision.
	 * @param array $error         error_get_last() output.
	 * @return bool
	 */
	public static function filter_should_handle( $should_handle, $error ) {
		self::record_fatal( $error );
		return $should_handle;
	}

	/**
	 * Shutdown handler for the case WordPress's fatal handler is disabled.
	 */
	public static function on_shutdown() {
		if ( self::$fatal_recorded ) {
			return;
		}
		$error = error_get_last();
		if ( is_array( $error ) ) {
			self::record_fatal( $error );
		}
	}

	/**
	 * Stores a fatal error in a non-autoloaded option.
	 *
	 * @param mixed $error error_get_last() output.
	 */
	public static function record_fatal( $error ) {
		if ( self::$fatal_recorded || ! is_array( $error ) || ! isset( $error['type'] ) ) {
			return;
		}
		$fatal = E_ERROR | E_PARSE | E_CORE_ERROR | E_COMPILE_ERROR | E_USER_ERROR | E_RECOVERABLE_ERROR;
		if ( ! ( (int) $error['type'] & $fatal ) ) {
			return;
		}
		self::$fatal_recorded = true;
		if ( ! function_exists( 'update_option' ) || ! function_exists( 'get_option' ) ) {
			return;
		}

		try {
			$message = isset( $error['message'] ) ? substr( (string) $error['message'], 0, 2000 ) : '';
			$file    = isset( $error['file'] ) ? (string) $error['file'] : '';
			$line    = isset( $error['line'] ) ? (int) $error['line'] : 0;
			$now     = time();

			// The query string can carry tokens; keep only the path.
			$url = '';
			if ( isset( $_SERVER['REQUEST_URI'] ) ) {
				$uri = (string) $_SERVER['REQUEST_URI']; // phpcs:ignore WordPress.Security
				$q   = strpos( $uri, '?' );
				$url = (string) preg_replace( '/[^\x21-\x7E]/', '', false === $q ? $uri : substr( $uri, 0, $q ) );
				$url = substr( $url, 0, 300 ) . ( false === $q ? '' : '?[query removed]' );
			}

			$previous = get_option( self::FATAL_OPTION );
			$count    = 1;
			if ( is_array( $previous ) && isset( $previous['message'], $previous['file'], $previous['line'] )
				&& $previous['message'] === $message && $previous['file'] === $file && (int) $previous['line'] === $line ) {
				// A fatal on every request should not become a write on every request.
				if ( isset( $previous['time'] ) && $now - (int) $previous['time'] < 60 ) {
					return;
				}
				$count = isset( $previous['count'] ) ? (int) $previous['count'] + 1 : 2;
			}

			update_option(
				self::FATAL_OPTION,
				array(
					'message' => $message,
					'file'    => $file,
					'line'    => $line,
					'type'    => (int) $error['type'],
					'url'     => $url,
					'time'    => $now,
					'count'   => $count,
				),
				false
			);
		} catch ( \Throwable $e ) { // phpcs:ignore Generic.CodeAnalysis.EmptyStatement
			// Recording must never make a fatal worse.
		}
	}

	/**
	 * Route table.
	 */
	public function register_routes() {
		$ns    = WPXMCP_NAMESPACE;
		$admin = array( WPXMCP_REST::instance(), 'require_admin' );

		register_rest_route( $ns, '/logs', array(
			'methods'             => WP_REST_Server::READABLE,
			'callback'            => array( $this, 'get_logs' ),
			'permission_callback' => $admin,
			'args'                => array(
				'lines' => array( 'type' => 'integer', 'default' => 200 ),
				'level' => array( 'type' => 'string', 'default' => 'all' ),
				'since' => array( 'type' => 'string' ),
				'grep'  => array( 'type' => 'string' ),
			),
		) );

		register_rest_route( $ns, '/cache/purge', array(
			'methods'             => WP_REST_Server::CREATABLE,
			'callback'            => array( $this, 'purge_cache' ),
			'permission_callback' => $admin,
			'args'                => array(
				'scope' => array( 'type' => 'string', 'default' => 'all' ),
				'url'   => array( 'type' => 'string' ),
			),
		) );

		register_rest_route( $ns, '/security', array(
			'methods'             => WP_REST_Server::READABLE,
			'callback'            => array( $this, 'security' ),
			'permission_callback' => $admin,
		) );

		register_rest_route( $ns, '/backups', array(
			'methods'             => WP_REST_Server::READABLE,
			'callback'            => array( $this, 'backups' ),
			'permission_callback' => $admin,
		) );
	}

	/* ------------------------------------------------------------------ *
	 * Paths
	 * ------------------------------------------------------------------ */

	/**
	 * Replaces absolute install paths with relative ones.
	 *
	 * @param string $text Text that may contain paths.
	 * @return string
	 */
	public static function redact_paths( $text ) {
		$text = (string) $text;
		$map  = array();

		$pairs = array(
			array( defined( 'WP_PLUGIN_DIR' ) ? WP_PLUGIN_DIR : '', 'wp-content/plugins' ),
			array( defined( 'WPMU_PLUGIN_DIR' ) ? WPMU_PLUGIN_DIR : '', 'wp-content/mu-plugins' ),
			array( function_exists( 'get_theme_root' ) ? get_theme_root() : '', 'wp-content/themes' ),
			array( defined( 'WP_CONTENT_DIR' ) ? WP_CONTENT_DIR : '', 'wp-content' ),
			array( ABSPATH, '' ),
		);
		foreach ( $pairs as $pair ) {
			$dir = untrailingslashit( (string) $pair[0] );
			if ( '' === $dir ) {
				continue;
			}
			$variants = array( $dir );
			$real     = realpath( $dir );
			if ( $real && $real !== $dir ) {
				$variants[] = $real;
			}
			foreach ( $variants as $variant ) {
				$map[ $variant . '/' ] = '' === $pair[1] ? '' : $pair[1] . '/';
				$map[ $variant ]       = '' === $pair[1] ? '.' : $pair[1];
			}
		}
		// Longest first, so a specific directory wins over its parent.
		uksort( $map, static function ( $a, $b ) {
			return strlen( $b ) - strlen( $a );
		} );
		$text = strtr( $text, $map );
		// PHP shortens long string arguments in stack traces ('/home/acme/pub...'), which strtr cannot match.
		return (string) preg_replace( "#'(?:[A-Za-z]:)?/[^'\\s]*\\.\\.\\.'#", "'…'", $text );
	}

	/**
	 * Which component a (redacted) path belongs to.
	 *
	 * @param string $path Relative path.
	 * @return string|null
	 */
	public static function attribute_path( $path ) {
		$path = ltrim( str_replace( '\\', '/', (string) $path ), '/' );
		if ( '' === $path ) {
			return null;
		}
		if ( preg_match( '#(?:^|/)wp-content/plugins/([^/]+)#', $path, $m ) ) {
			return 'plugins/' . $m[1];
		}
		if ( preg_match( '#(?:^|/)wp-content/mu-plugins(?:/|$)#', $path ) ) {
			return 'mu-plugins';
		}
		if ( preg_match( '#(?:^|/)wp-content/themes/([^/]+)#', $path, $m ) ) {
			return 'themes/' . $m[1];
		}
		if ( preg_match( '#^(?:wp-includes|wp-admin)/#', $path ) || preg_match( '#^(?:wp-[a-z-]+|index|xmlrpc)\.php$#', $path ) ) {
			return 'core';
		}
		if ( preg_match( '#^wp-content/[^/]+\.php$#', $path ) ) {
			return 'drop-in';
		}
		return null;
	}

	/* ------------------------------------------------------------------ *
	 * Logs
	 * ------------------------------------------------------------------ */

	/**
	 * Where the error log is, and why.
	 *
	 * @return array{path:string,via:string}
	 */
	private function resolve_log_path() {
		$ini = (string) ini_get( 'error_log' );
		if ( defined( 'WP_DEBUG_LOG' ) ) {
			if ( true === WP_DEBUG_LOG || in_array( strtolower( (string) WP_DEBUG_LOG ), array( '1', 'true' ), true ) ) {
				return array( 'path' => WP_CONTENT_DIR . '/debug.log', 'via' => 'WP_DEBUG_LOG (true → wp-content/debug.log)' );
			}
			if ( is_string( WP_DEBUG_LOG ) && '' !== WP_DEBUG_LOG && ! in_array( strtolower( WP_DEBUG_LOG ), array( '0', 'false' ), true ) ) {
				return array( 'path' => WP_DEBUG_LOG, 'via' => 'WP_DEBUG_LOG (custom path)' );
			}
		}
		return array( 'path' => $ini, 'via' => 'php.ini error_log' );
	}

	/**
	 * Reads the last lines of a file without reading the whole file.
	 *
	 * @param string $path      File.
	 * @param int    $max_lines Lines wanted.
	 * @return array{lines:array,scan_capped:bool}|null
	 */
	private function tail_file( $path, $max_lines ) {
		$fh = @fopen( $path, 'rb' ); // phpcs:ignore
		if ( ! $fh ) {
			return null;
		}
		fseek( $fh, 0, SEEK_END );
		$pos    = ftell( $fh );
		$buffer = '';
		$lines  = array();
		$read   = 0;
		$capped = false;
		$chunk  = 65536;

		// Stop one line past the target so the oldest kept line is complete.
		while ( $pos > 0 && count( $lines ) <= $max_lines ) {
			if ( $read >= self::MAX_SCAN_BYTES ) {
				$capped = true;
				break;
			}
			$len  = (int) min( $chunk, $pos );
			$pos -= $len;
			fseek( $fh, $pos );
			$data  = (string) fread( $fh, $len );
			$read += strlen( $data );

			$parts  = explode( "\n", $data . $buffer );
			$buffer = (string) array_shift( $parts );
			if ( $parts ) {
				$lines = array_merge( $parts, $lines );
			}
		}
		fclose( $fh );
		if ( 0 === $pos && '' !== $buffer ) {
			array_unshift( $lines, $buffer );
		}
		while ( $lines && '' === trim( (string) end( $lines ) ) ) {
			array_pop( $lines );
		}
		if ( count( $lines ) > $max_lines ) {
			$lines = array_slice( $lines, -$max_lines );
		}
		foreach ( $lines as $i => $line ) {
			$line        = rtrim( $line, "\r" );
			$lines[ $i ] = strlen( $line ) > 4000 ? substr( $line, 0, 4000 ) . '…' : $line;
		}
		return array( 'lines' => $lines, 'scan_capped' => $capped );
	}

	/**
	 * Severity rank used by the level filter.
	 *
	 * @param string $level Level.
	 * @return int
	 */
	private static function level_rank( $level ) {
		$ranks = array( 'fatal' => 5, 'error' => 4, 'warning' => 3, 'notice' => 2, 'deprecated' => 1, 'other' => 0 );
		return isset( $ranks[ $level ] ) ? $ranks[ $level ] : 0;
	}

	/**
	 * Parses one timestamped PHP log line.
	 *
	 * @param string $line Line.
	 * @return array|null
	 */
	public static function parse_log_line( $line ) {
		if ( ! preg_match( '/^\[([^\]]{6,64})\]\s+(.*)$/s', (string) $line, $m ) ) {
			return null;
		}
		$time = strtotime( $m[1] );
		$body = trim( $m[2] );

		$level = 'other';
		$kind  = '';
		if ( preg_match( '/^PHP ([A-Za-z ]+?):\s+(.*)$/s', $body, $k ) ) {
			$kind = strtolower( $k[1] );
			$body = $k[2];
			if ( false !== strpos( $kind, 'fatal' ) || false !== strpos( $kind, 'parse' ) || in_array( $kind, array( 'core error', 'compile error' ), true ) ) {
				$level = 'fatal';
			} elseif ( false !== strpos( $kind, 'warning' ) ) {
				$level = 'warning';
			} elseif ( false !== strpos( $kind, 'notice' ) || false !== strpos( $kind, 'strict' ) ) {
				$level = 'notice';
			} elseif ( false !== strpos( $kind, 'deprecated' ) ) {
				$level = 'deprecated';
			} elseif ( false !== strpos( $kind, 'error' ) ) {
				$level = 'error';
			}
		} elseif ( 0 === stripos( $body, 'WordPress database error' ) ) {
			$level = 'error';
			$kind  = 'database error';
		}

		$file = null;
		$ln   = null;
		if ( preg_match( '/ in ((?:[A-Za-z]:)?[\/\\\\][^\s]+?\.php|[^\s]+?\.php)(?: on line |:|\()(\d+)/', $body, $f ) ) {
			$file = $f[1];
			$ln   = (int) $f[2];
		}

		return array(
			'time'    => false === $time ? null : $time,
			'raw_ts'  => $m[1],
			'level'   => $level,
			'kind'    => $kind,
			'message' => $body,
			'file'    => $file,
			'line'    => $ln,
		);
	}

	/**
	 * GET /logs.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array
	 */
	public function get_logs( $request ) {
		$lines = max( 1, min( self::MAX_LINES, (int) $request->get_param( 'lines' ) ) );
		$level = strtolower( (string) $request->get_param( 'level' ) );
		if ( ! in_array( $level, array( 'fatal', 'error', 'warning', 'notice', 'deprecated', 'all' ), true ) ) {
			$level = 'all';
		}
		$since_raw = (string) $request->get_param( 'since' );
		$since     = '' !== $since_raw ? strtotime( $since_raw ) : false;
		$grep      = (string) $request->get_param( 'grep' );

		$resolved = $this->resolve_log_path();
		$path     = $resolved['path'];
		$notes    = array();

		$display = defined( 'WP_DEBUG_DISPLAY' ) ? (bool) WP_DEBUG_DISPLAY : true;
		$debug   = array(
			'WP_DEBUG'         => defined( 'WP_DEBUG' ) && WP_DEBUG,
			'WP_DEBUG_LOG'     => defined( 'WP_DEBUG_LOG' ) ? ( is_string( WP_DEBUG_LOG ) ? self::redact_paths( WP_DEBUG_LOG ) : (bool) WP_DEBUG_LOG ) : false,
			'WP_DEBUG_DISPLAY' => $display,
			'display_errors'   => (string) ini_get( 'display_errors' ),
			'log_errors'       => (bool) ini_get( 'log_errors' ),
			'php_error_log'    => self::redact_paths( (string) ini_get( 'error_log' ) ),
		);
		if ( $debug['WP_DEBUG'] && $display ) {
			$notes[] = 'WP_DEBUG_DISPLAY is on (it defaults to true), so errors are printed into pages and REST responses. Set define( \'WP_DEBUG_DISPLAY\', false ) on any public site.';
		}
		if ( defined( 'WP_DEBUG_LOG' ) && WP_DEBUG_LOG && ! $debug['WP_DEBUG'] ) {
			$notes[] = 'WP_DEBUG_LOG is set but WP_DEBUG is off, so WordPress does not route errors to that file; new entries may be missing.';
		}

		$log = array(
			'path'          => self::redact_paths( $path ),
			'configured_via' => $resolved['via'],
			'exists'        => false,
			'readable'      => false,
			'size_bytes'    => null,
			'modified_gmt'  => null,
		);

		$groups  = array();
		$scanned = 0;
		$matched = 0;

		if ( '' === $path || in_array( strtolower( $path ), array( 'syslog', 'stderr', '/dev/stderr', 'php://stderr' ), true ) ) {
			$notes[] = 'PHP is logging to the server\'s stderr/syslog, which WordPress cannot read. To capture errors in a file, add define( \'WP_DEBUG\', true ); define( \'WP_DEBUG_LOG\', true ); define( \'WP_DEBUG_DISPLAY\', false ); to wp-config.php.';
		} elseif ( ! @is_file( $path ) ) { // phpcs:ignore
			$notes[] = 'The log file does not exist yet — either nothing has been logged, or logging is off.';
		} else {
			$log['exists']       = true;
			$log['readable']     = is_readable( $path );
			$log['size_bytes']   = @filesize( $path ); // phpcs:ignore
			$mtime               = @filemtime( $path ); // phpcs:ignore
			$log['modified_gmt'] = $mtime ? gmdate( 'c', $mtime ) : null;

			$tail = $log['readable'] ? $this->tail_file( $path, $lines ) : null;
			if ( null === $tail ) {
				$notes[] = 'The log file exists but PHP cannot read it (file permissions).';
			} else {
				$scanned = count( $tail['lines'] );
				if ( $tail['scan_capped'] ) {
					$notes[] = 'Stopped reading after 8 MB from the end of the file; some requested lines were not scanned.';
				}
				$entries = $this->parse_entries( $tail['lines'] );
				$min     = 'all' === $level ? -1 : self::level_rank( $level );

				foreach ( $entries as $entry ) {
					if ( $min >= 0 && self::level_rank( $entry['level'] ) < $min ) {
						continue;
					}
					if ( false !== $since && null !== $entry['time'] && $entry['time'] < $since ) {
						continue;
					}
					if ( '' !== $grep && false === stripos( $entry['message'] . "\n" . implode( "\n", $entry['trace'] ), $grep ) ) {
						continue;
					}
					++$matched;

					$message = self::redact_paths( $entry['message'] );
					$file    = null === $entry['file'] ? null : self::redact_paths( $entry['file'] );
					$key     = md5( $entry['level'] . '|' . $message . '|' . $file . '|' . $entry['line'] );
					$ts      = null === $entry['time'] ? $entry['raw_ts'] : gmdate( 'c', $entry['time'] );

					if ( ! isset( $groups[ $key ] ) ) {
						$trace  = array_map( array( __CLASS__, 'redact_paths' ), array_slice( $entry['trace'], 0, 15 ) );
						$source = null === $file ? null : self::attribute_path( $file );
						if ( null === $source || 'core' === $source ) {
							// A core file named in the message often just reports a plugin's misuse; the trace says whose.
							foreach ( array_merge( array( $message ), $trace ) as $text ) {
								if ( preg_match( '#wp-content/(?:plugins|themes)/[^/\s]+|wp-content/mu-plugins#', $text, $pm ) ) {
									$source = self::attribute_path( $pm[0] . '/' );
									break;
								}
							}
						}
						$groups[ $key ] = array(
							'level'      => $entry['level'],
							'message'    => strlen( $message ) > 1000 ? substr( $message, 0, 1000 ) . '…' : $message,
							'file'       => $file,
							'line'       => $entry['line'],
							'source'     => null === $source ? ( null === $file ? 'unknown' : 'other' ) : $source,
							'count'      => 0,
							'first_seen' => $ts,
							'last_seen'  => $ts,
							'sort'       => (int) $entry['time'],
							'seq'        => $matched,
						);
						if ( $trace ) {
							$groups[ $key ]['trace'] = $trace;
						}
					}
					++$groups[ $key ]['count'];
					$groups[ $key ]['last_seen'] = $ts;
					$groups[ $key ]['sort']      = (int) $entry['time'];
					$groups[ $key ]['seq']       = $matched;
				}
			}
		}

		$groups = array_values( $groups );
		usort( $groups, static function ( $a, $b ) {
			return $b['sort'] === $a['sort'] ? $b['seq'] - $a['seq'] : $b['sort'] - $a['sort'];
		} );
		foreach ( $groups as $i => $g ) {
			unset( $groups[ $i ]['sort'], $groups[ $i ]['seq'] );
		}

		$by_source = array();
		foreach ( $groups as $g ) {
			$by_source[ $g['source'] ] = ( isset( $by_source[ $g['source'] ] ) ? $by_source[ $g['source'] ] : 0 ) + $g['count'];
		}
		arsort( $by_source );

		$last_fatal = get_option( self::FATAL_OPTION );
		if ( is_array( $last_fatal ) ) {
			$last_fatal['message'] = self::redact_paths( isset( $last_fatal['message'] ) ? $last_fatal['message'] : '' );
			$last_fatal['file']    = self::redact_paths( isset( $last_fatal['file'] ) ? $last_fatal['file'] : '' );
			$last_fatal['source']  = self::attribute_path( $last_fatal['file'] );
			$last_fatal['time_gmt'] = isset( $last_fatal['time'] ) ? gmdate( 'c', (int) $last_fatal['time'] ) : null;
			unset( $last_fatal['time'] );
		} else {
			$last_fatal = null;
		}

		$out = array(
			'log'              => $log,
			'debug'            => $debug,
			'filters'          => array( 'lines' => $lines, 'level' => $level, 'since' => false === $since ? null : gmdate( 'c', $since ), 'grep' => '' === $grep ? null : $grep ),
			'scanned_lines'    => $scanned,
			'matched_entries'  => $matched,
			'distinct'         => count( $groups ),
			'by_source'        => (object) $by_source,
			'groups'           => $groups,
			'last_fatal'       => $last_fatal,
			'notes'            => $notes,
		);

		// Keep the response inside its budget by dropping the oldest groups.
		$size = strlen( (string) wp_json_encode( $out ) );
		if ( $size > self::MAX_RESPONSE_BYTES ) {
			while ( $out['groups'] && strlen( (string) wp_json_encode( $out ) ) > self::MAX_RESPONSE_BYTES ) {
				$drop = max( 1, (int) ( count( $out['groups'] ) / 10 ) );
				array_splice( $out['groups'], -$drop );
			}
			$out['notes'][] = 'Response trimmed to about 200 KB: only the ' . count( $out['groups'] ) . ' most recent distinct entries are listed. Narrow with level, since or grep.';
		}

		return $out;
	}

	/**
	 * Turns raw lines into entries, attaching untimestamped lines (stack traces)
	 * to the entry above them.
	 *
	 * @param array $lines Lines, oldest first.
	 * @return array
	 */
	private function parse_entries( $lines ) {
		$entries = array();
		$current = null;
		foreach ( $lines as $line ) {
			$parsed = self::parse_log_line( $line );
			if ( null !== $parsed ) {
				if ( null !== $current ) {
					$entries[] = $current;
				}
				$parsed['trace'] = array();
				$current         = $parsed;
				continue;
			}
			if ( '' === trim( $line ) ) {
				continue;
			}
			if ( null === $current ) {
				// Continuation of an entry that began before the tail window.
				continue;
			}
			if ( count( $current['trace'] ) < 30 ) {
				$current['trace'][] = $line;
			}
		}
		if ( null !== $current ) {
			$entries[] = $current;
		}
		return $entries;
	}

	/* ------------------------------------------------------------------ *
	 * Cache purge
	 * ------------------------------------------------------------------ */

	/**
	 * POST /cache/purge.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function purge_cache( $request ) {
		$scope = 'url' === $request->get_param( 'scope' ) ? 'url' : 'all';
		$url   = trim( (string) $request->get_param( 'url' ) );

		$post_id = 0;
		if ( 'url' === $scope ) {
			if ( '' === $url ) {
				return new WP_Error( 'wpxmcp_missing_url', 'scope "url" needs a url.', array( 'status' => 400 ) );
			}
			if ( 0 === strpos( $url, '/' ) ) {
				$url = home_url( $url );
			}
			$home_host = wp_parse_url( home_url(), PHP_URL_HOST );
			$url_host  = wp_parse_url( $url, PHP_URL_HOST );
			if ( ! $url_host || strtolower( (string) $url_host ) !== strtolower( (string) $home_host ) ) {
				return new WP_Error( 'wpxmcp_offsite_url', 'Only URLs on this site can be purged.', array( 'status' => 400 ) );
			}
			$post_id = url_to_postid( $url );
			if ( ! $post_id && untrailingslashit( $url ) === untrailingslashit( home_url() ) ) {
				$post_id = (int) get_option( 'page_on_front' );
			}
		}

		$detected = array();
		$purged   = array();
		$errors   = array();
		$notes    = array();

		foreach ( $this->cache_layers() as $name => $layer ) {
			$present = false;
			try {
				$present = (bool) call_user_func( $layer['detect'] );
			} catch ( \Throwable $e ) {
				$present = false;
			}
			if ( ! $present ) {
				continue;
			}
			$detected[] = $name;
			try {
				if ( 'url' === $scope ) {
					if ( isset( $layer['url'] ) ) {
						$done = call_user_func( $layer['url'], $url, $post_id );
						if ( false === $done ) {
							call_user_func( $layer['all'] );
							$purged[] = $name . ' (entire cache — no per-URL purge available in this version)';
						} else {
							$purged[] = $name;
						}
					} else {
						call_user_func( $layer['all'] );
						$purged[] = $name . ' (entire cache — it has no per-URL purge)';
					}
				} else {
					call_user_func( $layer['all'] );
					$purged[] = $name;
				}
			} catch ( \Throwable $e ) {
				$errors[] = array( 'layer' => $name, 'error' => self::redact_paths( $e->getMessage() ) );
			}
		}

		if ( 'all' === $scope ) {
			$flushed  = wp_cache_flush();
			$purged[] = wp_using_ext_object_cache() ? 'object cache (persistent, flushed)' : 'object cache (in-memory only)';
			if ( ! $flushed && wp_using_ext_object_cache() ) {
				$errors[] = array( 'layer' => 'object cache', 'error' => 'wp_cache_flush() returned false.' );
			}
		} elseif ( $post_id ) {
			clean_post_cache( $post_id );
			$purged[] = 'object cache for post ' . $post_id;
		} else {
			$notes[] = 'The URL did not resolve to a post, so no per-post object cache was cleared.';
		}

		if ( ! $detected ) {
			$notes[] = 'No page-cache plugin or known host cache was detected. A CDN (Cloudflare, Fastly) or a server cache (Varnish, nginx fastcgi_cache) in front of WordPress is invisible from here and must be purged at its own dashboard.';
		} else {
			$notes[] = 'Only caches WordPress can reach were purged. A CDN in front of the site keeps its own copy until purged there.';
		}

		wpxmcp_audit( 'cache_purge', array( 'scope' => $scope, 'url' => $url, 'purged' => $purged ) );

		return array(
			'scope'    => $scope,
			'url'      => 'url' === $scope ? $url : null,
			'post_id'  => $post_id ? $post_id : null,
			'detected' => $detected,
			'purged'   => $purged,
			'errors'   => $errors,
			'note'     => implode( ' ', $notes ),
		);
	}

	/**
	 * Known cache layers, each with detection and purge callables.
	 * A `url` callable returning false means "cannot target a URL here".
	 *
	 * @return array
	 */
	private function cache_layers() {
		$layers = array();

		// Page builders cache generated CSS per post. A stale file survives every page
		// cache purge, so these go first. Each call is guarded, so an API that moved
		// in a later builder version is skipped rather than fatal.
		$layers['Elementor CSS'] = array(
			'detect' => static function () {
				return class_exists( '\Elementor\Plugin' ) && isset( \Elementor\Plugin::$instance->files_manager );
			},
			'all'    => static function () {
				\Elementor\Plugin::$instance->files_manager->clear_cache();
			},
			'url'    => static function ( $url, $post_id ) {
				if ( ! $post_id ) {
					return false;
				}
				delete_post_meta( $post_id, '_elementor_css' );
				delete_post_meta( $post_id, '_elementor_element_cache' );
				return true;
			},
		);

		$layers['Beaver Builder assets'] = array(
			'detect' => static function () {
				return class_exists( 'FLBuilderModel' ) && method_exists( 'FLBuilderModel', 'delete_asset_cache_for_all_posts' );
			},
			'all'    => static function () {
				FLBuilderModel::delete_asset_cache_for_all_posts();
			},
			'url'    => static function ( $url, $post_id ) {
				if ( ! $post_id || ! method_exists( 'FLBuilderModel', 'delete_all_asset_cache' ) ) {
					return false;
				}
				FLBuilderModel::delete_all_asset_cache( $post_id );
				return true;
			},
		);

		$layers['Divi static CSS'] = array(
			'detect' => static function () {
				return class_exists( 'ET_Core_PageResource' ) && method_exists( 'ET_Core_PageResource', 'remove_static_resources' );
			},
			'all'    => static function () {
				ET_Core_PageResource::remove_static_resources( 'all', 'all' );
			},
			'url'    => static function ( $url, $post_id ) {
				if ( ! $post_id ) {
					return false;
				}
				ET_Core_PageResource::remove_static_resources( $post_id, 'all' );
				return true;
			},
		);

		$layers['WP Rocket'] = array(
			'detect' => static function () {
				return function_exists( 'rocket_clean_domain' );
			},
			'all'    => static function () {
				rocket_clean_domain();
				if ( function_exists( 'rocket_clean_minify' ) ) {
					rocket_clean_minify();
				}
			},
			'url'    => static function ( $url ) {
				if ( ! function_exists( 'rocket_clean_files' ) ) {
					return false;
				}
				rocket_clean_files( array( $url ) );
				return true;
			},
		);

		$layers['LiteSpeed Cache'] = array(
			'detect' => static function () {
				return defined( 'LSCWP_V' ) || class_exists( 'LiteSpeed\Core' ) || has_action( 'litespeed_purge_all' );
			},
			'all'    => static function () {
				do_action( 'litespeed_purge_all' );
			},
			'url'    => static function ( $url ) {
				do_action( 'litespeed_purge_url', $url );
				return true;
			},
		);

		$layers['W3 Total Cache'] = array(
			'detect' => static function () {
				return function_exists( 'w3tc_flush_all' );
			},
			'all'    => static function () {
				w3tc_flush_all();
			},
			'url'    => static function ( $url, $post_id ) {
				if ( function_exists( 'w3tc_flush_url' ) ) {
					w3tc_flush_url( $url );
					return true;
				}
				if ( $post_id && function_exists( 'w3tc_flush_post' ) ) {
					w3tc_flush_post( $post_id );
					return true;
				}
				return false;
			},
		);

		$layers['WP Super Cache'] = array(
			'detect' => static function () {
				return function_exists( 'wp_cache_clear_cache' );
			},
			'all'    => static function () {
				wp_cache_clear_cache();
			},
			'url'    => static function ( $url, $post_id ) {
				if ( function_exists( 'wpsc_delete_url_cache' ) ) {
					wpsc_delete_url_cache( $url );
					return true;
				}
				if ( $post_id && function_exists( 'wp_cache_post_change' ) ) {
					wp_cache_post_change( $post_id );
					return true;
				}
				return false;
			},
		);

		$layers['WP Fastest Cache'] = array(
			'detect' => static function () {
				return class_exists( 'WpFastestCache' );
			},
			'all'    => static function () {
				if ( function_exists( 'wpfc_clear_all_cache' ) ) {
					wpfc_clear_all_cache( true );
					return;
				}
				$GLOBALS['wp_fastest_cache'] = isset( $GLOBALS['wp_fastest_cache'] ) ? $GLOBALS['wp_fastest_cache'] : new WpFastestCache();
				if ( method_exists( $GLOBALS['wp_fastest_cache'], 'deleteCache' ) ) {
					$GLOBALS['wp_fastest_cache']->deleteCache( true );
				}
			},
			'url'    => static function ( $url, $post_id ) {
				if ( $post_id && function_exists( 'wpfc_clear_post_cache_by_id' ) ) {
					wpfc_clear_post_cache_by_id( $post_id );
					return true;
				}
				return false;
			},
		);

		$layers['SiteGround Speed Optimizer'] = array(
			'detect' => static function () {
				return function_exists( 'sg_cachepress_purge_cache' ) || function_exists( 'sg_cachepress_purge_everything' );
			},
			'all'    => static function () {
				if ( function_exists( 'sg_cachepress_purge_everything' ) ) {
					sg_cachepress_purge_everything();
				} else {
					sg_cachepress_purge_cache();
				}
			},
			'url'    => static function ( $url ) {
				if ( ! function_exists( 'sg_cachepress_purge_cache' ) ) {
					return false;
				}
				sg_cachepress_purge_cache( $url );
				return true;
			},
		);

		$layers['Cache Enabler'] = array(
			'detect' => static function () {
				return class_exists( 'Cache_Enabler' ) && method_exists( 'Cache_Enabler', 'clear_complete_cache' );
			},
			'all'    => static function () {
				Cache_Enabler::clear_complete_cache();
			},
			'url'    => static function ( $url ) {
				if ( ! method_exists( 'Cache_Enabler', 'clear_page_cache_by_url' ) ) {
					return false;
				}
				Cache_Enabler::clear_page_cache_by_url( $url );
				return true;
			},
		);

		$layers['Breeze'] = array(
			'detect' => static function () {
				return defined( 'BREEZE_VERSION' ) || class_exists( 'Breeze_Admin' );
			},
			'all'    => static function () {
				do_action( 'breeze_clear_all_cache' );
			},
		);

		$layers['Hummingbird'] = array(
			'detect' => static function () {
				return defined( 'WPHB_VERSION' ) || class_exists( 'Hummingbird\WP_Hummingbird' );
			},
			'all'    => static function () {
				do_action( 'wphb_clear_page_cache' );
			},
			'url'    => static function ( $url, $post_id ) {
				if ( ! $post_id ) {
					return false;
				}
				do_action( 'wphb_clear_page_cache', $post_id );
				return true;
			},
		);

		$layers['Nginx Helper'] = array(
			'detect' => static function () {
				return defined( 'NGINX_HELPER_BASENAME' ) || class_exists( 'Nginx_Helper' ) || has_action( 'rt_nginx_helper_purge_all' );
			},
			'all'    => static function () {
				do_action( 'rt_nginx_helper_purge_all' );
			},
			'url'    => static function ( $url ) {
				global $nginx_purger;
				if ( ! is_object( $nginx_purger ) || ! method_exists( $nginx_purger, 'purge_url' ) ) {
					return false;
				}
				$nginx_purger->purge_url( $url );
				return true;
			},
		);

		$layers['Autoptimize'] = array(
			'detect' => static function () {
				return class_exists( 'autoptimizeCache' ) && method_exists( 'autoptimizeCache', 'clearall' );
			},
			'all'    => static function () {
				autoptimizeCache::clearall();
			},
		);

		$layers['Proxy Cache Purge (Varnish)'] = array(
			'detect' => static function () {
				return class_exists( 'VarnishPurger' );
			},
			'all'    => static function () {
				global $purger;
				if ( is_object( $purger ) && method_exists( $purger, 'purge_url' ) ) {
					$purger->purge_url( home_url( '/?vhp-regex' ) );
					return;
				}
				do_action( 'vhp_purge_all' );
			},
			'url'    => static function ( $url ) {
				global $purger;
				if ( ! is_object( $purger ) || ! method_exists( $purger, 'purge_url' ) ) {
					return false;
				}
				$purger->purge_url( $url );
				return true;
			},
		);

		$layers['WP-Optimize'] = array(
			'detect' => static function () {
				return class_exists( 'WPO_Page_Cache' ) && method_exists( 'WPO_Page_Cache', 'instance' );
			},
			'all'    => static function () {
				$cache = WPO_Page_Cache::instance();
				if ( method_exists( $cache, 'purge' ) ) {
					$cache->purge();
				}
			},
			'url'    => static function ( $url, $post_id ) {
				if ( $post_id && method_exists( 'WPO_Page_Cache', 'delete_single_post_cache' ) ) {
					WPO_Page_Cache::delete_single_post_cache( $post_id );
					return true;
				}
				return false;
			},
		);

		$layers['Cloudflare plugin'] = array(
			'detect' => static function () {
				return class_exists( 'CF\WordPress\Hooks' ) && method_exists( 'CF\WordPress\Hooks', 'purgeCacheEverything' );
			},
			'all'    => static function () {
				$hooks = new \CF\WordPress\Hooks();
				$hooks->purgeCacheEverything();
			},
		);

		$layers['Kinsta'] = array(
			'detect' => static function () {
				global $kinsta_cache;
				return is_object( $kinsta_cache ) && isset( $kinsta_cache->kinsta_cache_purge );
			},
			'all'    => static function () {
				global $kinsta_cache;
				if ( method_exists( $kinsta_cache->kinsta_cache_purge, 'purge_complete_caches' ) ) {
					$kinsta_cache->kinsta_cache_purge->purge_complete_caches();
				}
			},
		);

		$layers['WP Engine'] = array(
			'detect' => static function () {
				return class_exists( 'WpeCommon' );
			},
			'all'    => static function () {
				if ( method_exists( 'WpeCommon', 'purge_memcached' ) ) {
					WpeCommon::purge_memcached();
				}
				if ( method_exists( 'WpeCommon', 'purge_varnish_cache' ) ) {
					WpeCommon::purge_varnish_cache();
				}
			},
			'url'    => static function ( $url, $post_id ) {
				if ( $post_id && method_exists( 'WpeCommon', 'purge_varnish_cache' ) ) {
					WpeCommon::purge_varnish_cache( $post_id );
					return true;
				}
				return false;
			},
		);

		$layers['Pantheon Advanced Page Cache'] = array(
			'detect' => static function () {
				return function_exists( 'pantheon_wp_clear_edge_all' );
			},
			'all'    => static function () {
				pantheon_wp_clear_edge_all();
			},
			'url'    => static function ( $url ) {
				if ( ! function_exists( 'pantheon_wp_clear_edge_paths' ) ) {
					return false;
				}
				$path = wp_parse_url( $url, PHP_URL_PATH );
				pantheon_wp_clear_edge_paths( array( $path ? $path : '/' ) );
				return true;
			},
		);

		$layers['GoDaddy Managed WordPress'] = array(
			'detect' => static function () {
				return class_exists( 'WPaaS\Cache' ) && method_exists( 'WPaaS\Cache', 'ban' );
			},
			'all'    => static function () {
				\WPaaS\Cache::ban();
			},
		);

		return $layers;
	}

	/* ------------------------------------------------------------------ *
	 * Security posture
	 * ------------------------------------------------------------------ */

	/**
	 * GET /security — facts only; the MCP server scores them.
	 *
	 * @return array
	 */
	public function security() {
		global $wpdb, $wp_version;

		if ( ! function_exists( 'get_plugins' ) ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}

		// wp-config.php may sit one directory above ABSPATH.
		$config = null;
		if ( file_exists( ABSPATH . 'wp-config.php' ) ) {
			$config = ABSPATH . 'wp-config.php';
		} elseif ( @file_exists( dirname( ABSPATH ) . '/wp-config.php' ) && ! @file_exists( dirname( ABSPATH ) . '/wp-settings.php' ) ) { // phpcs:ignore
			$config = dirname( ABSPATH ) . '/wp-config.php';
		}
		$config_info = array( 'found' => null !== $config );
		if ( null !== $config ) {
			$perms       = @fileperms( $config ); // phpcs:ignore
			$mode        = false === $perms ? null : ( $perms & 0777 );
			$config_info = array(
				'found'             => true,
				'location'          => self::redact_paths( $config ),
				'above_webroot'     => dirname( $config ) !== untrailingslashit( ABSPATH ),
				'mode'              => null === $mode ? null : sprintf( '%04o', $mode ),
				'world_readable'    => null === $mode ? null : (bool) ( $mode & 0004 ),
				'world_writable'    => null === $mode ? null : (bool) ( $mode & 0002 ),
				'writable_by_php'   => wp_is_writable( $config ),
				'windows'           => 'WIN' === strtoupper( substr( PHP_OS, 0, 3 ) ),
			);
		}

		// Administrators and their application passwords.
		$weak_names = array( 'admin', 'administrator', 'root', 'test', 'user', 'webmaster', 'wordpress', 'demo', 'guest' );
		$admins     = get_users( array( 'role' => 'administrator', 'fields' => array( 'ID', 'user_login' ), 'number' => 200 ) );
		$admin_list = array();
		$app_total  = 0;
		foreach ( $admins as $admin ) {
			$entry = array(
				'id'       => (int) $admin->ID,
				'login'    => $admin->user_login,
				'weak_name' => in_array( strtolower( $admin->user_login ), $weak_names, true ),
			);
			if ( class_exists( 'WP_Application_Passwords' ) ) {
				$passwords = WP_Application_Passwords::get_user_application_passwords( $admin->ID );
				$last_used = null;
				$names     = array();
				foreach ( (array) $passwords as $p ) {
					if ( ! empty( $p['last_used'] ) && ( null === $last_used || $p['last_used'] > $last_used ) ) {
						$last_used = (int) $p['last_used'];
					}
					$names[] = array(
						'name'      => isset( $p['name'] ) ? $p['name'] : '',
						'created'   => ! empty( $p['created'] ) ? gmdate( 'c', (int) $p['created'] ) : null,
						'last_used' => ! empty( $p['last_used'] ) ? gmdate( 'c', (int) $p['last_used'] ) : null,
					);
				}
				$entry['application_passwords'] = count( (array) $passwords );
				$entry['app_password_last_used'] = null === $last_used ? null : gmdate( 'c', $last_used );
				$entry['app_password_list']      = array_slice( $names, 0, 20 );
				$app_total                      += count( (array) $passwords );
			}
			$admin_list[] = $entry;
		}

		// Installed plugins and themes, for vulnerability lookup.
		$active_plugins = (array) get_option( 'active_plugins', array() );
		if ( is_multisite() ) {
			$active_plugins = array_merge( $active_plugins, array_keys( (array) get_site_option( 'active_sitewide_plugins', array() ) ) );
		}
		$plugins = array();
		foreach ( get_plugins() as $file => $data ) {
			$slug      = false !== strpos( $file, '/' ) ? dirname( $file ) : basename( $file, '.php' );
			$plugins[] = array(
				'file'    => $file,
				'slug'    => $slug,
				'name'    => $data['Name'],
				'version' => $data['Version'],
				'active'  => in_array( $file, $active_plugins, true ),
			);
		}
		$themes = array();
		foreach ( wp_get_themes() as $stylesheet => $theme ) {
			$themes[] = array(
				'slug'    => $stylesheet,
				'name'    => $theme->get( 'Name' ),
				'version' => $theme->get( 'Version' ),
				'active'  => get_stylesheet() === $stylesheet || get_template() === $stylesheet,
			);
		}

		// Updates, from the cached transients only — no remote request.
		$update_core    = get_site_transient( 'update_core' );
		$update_plugins = get_site_transient( 'update_plugins' );
		$update_themes  = get_site_transient( 'update_themes' );
		$core_latest    = null;
		$core_upgrade   = false;
		if ( is_object( $update_core ) && ! empty( $update_core->updates ) ) {
			foreach ( $update_core->updates as $offer ) {
				if ( isset( $offer->response ) && 'upgrade' === $offer->response ) {
					$core_upgrade = true;
					$core_latest  = isset( $offer->current ) ? $offer->current : ( isset( $offer->version ) ? $offer->version : null );
					break;
				}
				if ( null === $core_latest && isset( $offer->current ) ) {
					$core_latest = $offer->current;
				}
			}
		}
		$plugin_updates = array();
		if ( is_object( $update_plugins ) && ! empty( $update_plugins->response ) ) {
			foreach ( $update_plugins->response as $file => $offer ) {
				$plugin_updates[] = array(
					'file'    => $file,
					'current' => isset( $update_plugins->checked[ $file ] ) ? $update_plugins->checked[ $file ] : null,
					'new'     => isset( $offer->new_version ) ? $offer->new_version : null,
				);
			}
		}
		$theme_updates = array();
		if ( is_object( $update_themes ) && ! empty( $update_themes->response ) ) {
			foreach ( $update_themes->response as $slug => $offer ) {
				$theme_updates[] = array(
					'slug'    => $slug,
					'current' => isset( $update_themes->checked[ $slug ] ) ? $update_themes->checked[ $slug ] : null,
					'new'     => isset( $offer['new_version'] ) ? $offer['new_version'] : null,
				);
			}
		}

		$default_phrase = 'put your unique phrase here';
		$salts_default  = false;
		foreach ( array( 'AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT' ) as $salt ) {
			if ( ! defined( $salt ) || '' === constant( $salt ) || $default_phrase === constant( $salt ) ) {
				$salts_default = true;
			}
		}

		$auto_plugins = (array) get_site_option( 'auto_update_plugins', array() );
		$auto_themes  = (array) get_site_option( 'auto_update_themes', array() );

		return array(
			'wordpress' => array(
				'version'     => $wp_version,
				'latest'      => $core_latest,
				'update_available' => $core_upgrade,
				'updates_checked_gmt' => is_object( $update_core ) && ! empty( $update_core->last_checked ) ? gmdate( 'c', (int) $update_core->last_checked ) : null,
				'environment' => function_exists( 'wp_get_environment_type' ) ? wp_get_environment_type() : 'production',
				'multisite'   => is_multisite(),
			),
			'php'       => array(
				'version' => PHP_VERSION,
			),
			'debug'     => array(
				'WP_DEBUG'         => defined( 'WP_DEBUG' ) && WP_DEBUG,
				'WP_DEBUG_DISPLAY' => defined( 'WP_DEBUG_DISPLAY' ) ? (bool) WP_DEBUG_DISPLAY : true,
				'WP_DEBUG_LOG'     => defined( 'WP_DEBUG_LOG' ) && WP_DEBUG_LOG,
				'display_errors'   => (bool) filter_var( ini_get( 'display_errors' ), FILTER_VALIDATE_BOOLEAN ) || 'stderr' === strtolower( (string) ini_get( 'display_errors' ) ),
				'debug_log_in_webroot' => defined( 'WP_DEBUG_LOG' ) && true === WP_DEBUG_LOG,
			),
			'hardening' => array(
				'DISALLOW_FILE_EDIT'  => defined( 'DISALLOW_FILE_EDIT' ) && DISALLOW_FILE_EDIT,
				'DISALLOW_FILE_MODS'  => defined( 'DISALLOW_FILE_MODS' ) && DISALLOW_FILE_MODS,
				'FORCE_SSL_ADMIN'     => defined( 'FORCE_SSL_ADMIN' ) && FORCE_SSL_ADMIN,
				'xmlrpc_enabled'      => (bool) apply_filters( 'xmlrpc_enabled', true ),
				'default_salts'       => $salts_default,
				'table_prefix'        => $wpdb->prefix,
				'users_can_register'  => (bool) get_option( 'users_can_register' ),
				'default_role'        => (string) get_option( 'default_role' ),
			),
			'wp_config' => $config_info,
			'ssl'       => array(
				'is_ssl'       => is_ssl(),
				'home_scheme'  => wp_parse_url( home_url(), PHP_URL_SCHEME ),
				'siteurl_scheme' => wp_parse_url( site_url(), PHP_URL_SCHEME ),
			),
			'admins'    => array(
				'count'                       => count( $admin_list ),
				'list'                        => $admin_list,
				'application_passwords_total' => $app_total,
				'application_passwords_available' => function_exists( 'wp_is_application_passwords_available' ) ? wp_is_application_passwords_available() : null,
			),
			'plugins'   => array(
				'total'    => count( $plugins ),
				'inactive' => count( array_filter( $plugins, static function ( $p ) {
					return ! $p['active'];
				} ) ),
				'installed' => $plugins,
				'updates'   => $plugin_updates,
				'auto_update_enabled' => count( array_intersect( $auto_plugins, array_column( $plugins, 'file' ) ) ),
			),
			'themes'    => array(
				'total'    => count( $themes ),
				'inactive' => count( array_filter( $themes, static function ( $t ) {
					return ! $t['active'];
				} ) ),
				'installed' => $themes,
				'updates'   => $theme_updates,
				'auto_update_enabled' => count( array_intersect( $auto_themes, array_column( $themes, 'slug' ) ) ),
			),
			'auto_updates' => array(
				'AUTOMATIC_UPDATER_DISABLED' => defined( 'AUTOMATIC_UPDATER_DISABLED' ) && AUTOMATIC_UPDATER_DISABLED,
				'WP_AUTO_UPDATE_CORE'        => defined( 'WP_AUTO_UPDATE_CORE' ) ? WP_AUTO_UPDATE_CORE : null,
			),
		);
	}

	/* ------------------------------------------------------------------ *
	 * Backups
	 * ------------------------------------------------------------------ */

	/**
	 * Timestamp → ISO 8601 UTC, or null.
	 *
	 * @param mixed $ts Unix timestamp.
	 * @return string|null
	 */
	private static function iso( $ts ) {
		$ts = is_numeric( $ts ) ? (int) $ts : 0;
		return $ts > 0 ? gmdate( 'c', $ts ) : null;
	}

	/**
	 * Whether a plugin directory is active.
	 *
	 * @param string $dir Plugin directory slug.
	 * @return bool
	 */
	private static function plugin_dir_active( $dir ) {
		$active = (array) get_option( 'active_plugins', array() );
		if ( is_multisite() ) {
			$active = array_merge( $active, array_keys( (array) get_site_option( 'active_sitewide_plugins', array() ) ) );
		}
		foreach ( $active as $file ) {
			if ( 0 === strpos( (string) $file, $dir . '/' ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * GET /backups.
	 *
	 * @return array
	 */
	public function backups() {
		global $wpdb;
		$detected = array();

		// UpdraftPlus.
		if ( class_exists( 'UpdraftPlus' ) || defined( 'UPDRAFTPLUS_DIR' ) || self::plugin_dir_active( 'updraftplus' ) ) {
			$last    = get_option( 'updraft_last_backup' );
			$history = get_option( 'updraft_backup_history' );
			$ts      = 0;
			if ( is_array( $last ) && ! empty( $last['backup_time'] ) && ( ! isset( $last['success'] ) || $last['success'] ) ) {
				$ts = (int) $last['backup_time'];
			}
			if ( is_array( $history ) && $history ) {
				$ts = max( $ts, (int) max( array_map( 'intval', array_keys( $history ) ) ) );
			}
			$service = get_option( 'updraft_service' );
			$dest    = is_array( $service ) ? implode( ', ', array_filter( array_map( 'strval', $service ) ) ) : (string) $service;
			$entry   = array(
				'plugin'          => 'UpdraftPlus',
				'last_backup_gmt' => self::iso( $ts ),
				'destination'     => '' === $dest || 'none' === $dest ? 'local only (no remote storage configured)' : $dest,
				'count'           => is_array( $history ) ? count( $history ) : 0,
			);
			if ( is_array( $last ) && isset( $last['success'] ) && ! $last['success'] ) {
				$entry['note'] = 'The most recent backup attempt did not succeed.';
			}
			$detected[] = $entry;
		}

		// BackWPup.
		if ( class_exists( 'BackWPup' ) || self::plugin_dir_active( 'backwpup' ) ) {
			$jobs  = get_site_option( 'backwpup_jobs', array() );
			$ts    = 0;
			$dests = array();
			foreach ( (array) $jobs as $job ) {
				if ( ! empty( $job['lastrun'] ) ) {
					$ts = max( $ts, (int) $job['lastrun'] );
				}
				if ( ! empty( $job['destinations'] ) ) {
					$dests = array_merge( $dests, (array) $job['destinations'] );
				}
			}
			$detected[] = array(
				'plugin'          => 'BackWPup',
				'last_backup_gmt' => self::iso( $ts ),
				'destination'     => $dests ? implode( ', ', array_unique( array_map( 'strval', $dests ) ) ) : null,
				'count'           => count( (array) $jobs ),
				'note'            => 'count is the number of backup jobs; last_backup_gmt is the most recent job run.',
			);
		}

		// Duplicator (free and Pro).
		if ( defined( 'DUPLICATOR_VERSION' ) || defined( 'DUPLICATOR_PRO_VERSION' ) || class_exists( 'DUP_Package' ) || self::plugin_dir_active( 'duplicator' ) || self::plugin_dir_active( 'duplicator-pro' ) ) {
			$ts    = 0;
			$count = 0;
			foreach ( array( 'duplicator_packages', 'duplicator_pro_packages', 'duplicator_backups' ) as $suffix ) {
				$table = $wpdb->base_prefix . $suffix;
				if ( $table !== $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $wpdb->esc_like( $table ) ) ) ) { // phpcs:ignore WordPress.DB
					continue;
				}
				$row = $wpdb->get_row( "SELECT COUNT(*) AS n, MAX(created) AS latest FROM `{$table}` WHERE status >= 100", ARRAY_A ); // phpcs:ignore WordPress.DB
				if ( $row ) {
					$count += (int) $row['n'];
					if ( ! empty( $row['latest'] ) ) {
						$t  = strtotime( $row['latest'] . ' UTC' );
						$ts = max( $ts, $t ? $t : 0 );
					}
				}
			}
			$detected[] = array(
				'plugin'          => 'Duplicator',
				'last_backup_gmt' => self::iso( $ts ),
				'count'           => $count,
			);
		}

		// All-in-One WP Migration.
		if ( defined( 'AI1WM_BACKUPS_PATH' ) || self::plugin_dir_active( 'all-in-one-wp-migration' ) ) {
			$dir   = defined( 'AI1WM_BACKUPS_PATH' ) ? AI1WM_BACKUPS_PATH : WP_CONTENT_DIR . '/ai1wm-backups';
			$files = @glob( trailingslashit( $dir ) . '*.wpress' ); // phpcs:ignore
			$ts    = 0;
			foreach ( (array) $files as $file ) {
				$ts = max( $ts, (int) @filemtime( $file ) ); // phpcs:ignore
			}
			$detected[] = array(
				'plugin'          => 'All-in-One WP Migration',
				'last_backup_gmt' => self::iso( $ts ),
				'destination'     => 'local (' . self::redact_paths( $dir ) . ')',
				'count'           => is_array( $files ) ? count( $files ) : 0,
			);
		}

		// Jetpack Backup / VaultPress.
		$jetpack_modules = (array) get_option( 'jetpack_active_modules', array() );
		if ( class_exists( 'VaultPress' ) || in_array( 'vaultpress', $jetpack_modules, true ) || self::plugin_dir_active( 'jetpack-backup' ) || self::plugin_dir_active( 'vaultpress' ) ) {
			$detected[] = array(
				'plugin'          => 'Jetpack VaultPress Backup',
				'last_backup_gmt' => null,
				'destination'     => 'Jetpack cloud',
				'note'            => 'Backups run on Jetpack\'s servers; the last backup time is only visible in the Jetpack dashboard.',
			);
		}

		// BlogVault.
		if ( class_exists( 'BVInfo' ) || defined( 'BVVERSION' ) || self::plugin_dir_active( 'blogvault-real-time-backup' ) ) {
			$detected[] = array(
				'plugin'          => 'BlogVault',
				'last_backup_gmt' => null,
				'destination'     => 'BlogVault cloud',
				'note'            => 'Backups are taken off-site by BlogVault; check its dashboard for the last backup time.',
			);
		}

		// WPvivid.
		if ( class_exists( 'WPvivid' ) || self::plugin_dir_active( 'wpvivid-backuprestore' ) ) {
			$list = get_option( 'wpvivid_backup_list', array() );
			$ts   = 0;
			$dest = array();
			foreach ( (array) $list as $backup ) {
				if ( is_array( $backup ) && ! empty( $backup['create_time'] ) ) {
					$ts = max( $ts, (int) $backup['create_time'] );
				}
				if ( is_array( $backup ) && ! empty( $backup['remote'] ) ) {
					$dest[] = 'remote';
				}
			}
			$detected[] = array(
				'plugin'          => 'WPvivid',
				'last_backup_gmt' => self::iso( $ts ),
				'destination'     => $dest ? 'local + remote' : 'local',
				'count'           => count( (array) $list ),
			);
		}

		// BackupBuddy / Solid Backups.
		if ( class_exists( 'pb_backupbuddy' ) || self::plugin_dir_active( 'backupbuddy' ) ) {
			$opts = get_option( 'pb_backupbuddy', array() );
			$ts   = 0;
			if ( is_array( $opts ) ) {
				foreach ( array( 'last_backup_finish', 'last_backup_start' ) as $k ) {
					if ( ! empty( $opts[ $k ] ) ) {
						$ts = (int) $opts[ $k ];
						break;
					}
				}
			}
			$detected[] = array(
				'plugin'          => 'BackupBuddy (Solid Backups)',
				'last_backup_gmt' => self::iso( $ts ),
			);
		}

		$latest = 0;
		foreach ( $detected as $d ) {
			if ( ! empty( $d['last_backup_gmt'] ) ) {
				$latest = max( $latest, (int) strtotime( $d['last_backup_gmt'] ) );
			}
		}
		$age = $latest ? round( ( time() - $latest ) / 3600, 1 ) : null;

		if ( ! $detected ) {
			$warning = 'No backup plugin detected. Host-level backups (cPanel, managed hosts, server snapshots) are invisible to WordPress — confirm with the host that they exist before making risky changes.';
		} elseif ( ! $latest ) {
			$warning = 'A backup plugin is installed but no completed backup time could be read. Check its dashboard and run a backup before risky changes.';
		} elseif ( $age > 168 ) {
			$warning = 'The most recent backup is more than 7 days old. Take a fresh backup before risky changes.';
		} elseif ( $age > 36 ) {
			$warning = 'The most recent backup is over a day old; consider a fresh one before risky changes.';
		} else {
			$warning = null;
		}

		return array(
			'detected'   => $detected,
			'latest_gmt' => $latest ? gmdate( 'c', $latest ) : null,
			'age_hours'  => $age,
			'warning'    => $warning,
		);
	}
}

WPXMCP_Diagnostics::early_hooks();
