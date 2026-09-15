<?php
/**
 * Per-request profiling of front-end URLs: template, queries, assets, HTTP calls and errors.
 *
 * How it works. An administrator asks the REST route for a token bound to one
 * path. The token is random, single-use and lives for two minutes. A front-end
 * request carrying `?wpxmcp_profile=<token>` for that path consumes the token as
 * early as the plugin can run (plugins_loaded), switches the collectors on for
 * that one request, and at shutdown stores the report in a transient the
 * administrator reads back through REST. Requests without a valid token never
 * register a single collector, so ordinary traffic pays one isset() check.
 * Nothing is ever printed into the profiled response.
 *
 * @package wpxmcp
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Per-request profiling of front-end URLs: template, queries, assets, HTTP calls and errors.
 */
class WPXMCP_Profiler {

	/** Query-string parameter carrying the token. */
	const PARAM = 'wpxmcp_profile';

	/** Seconds a token stays valid before it is used. */
	const TOKEN_TTL = 120;

	/** Seconds a finished report waits to be collected. */
	const RESULT_TTL = 300;

	/** Outstanding (unused, unexpired) tokens one user may hold. */
	const MAX_OUTSTANDING = 20;

	/** Approximate ceiling on a stored report, in bytes of JSON. */
	const MAX_REPORT_BYTES = 500000;

	/** Every section a report can contain. */
	const SECTIONS = array( 'template', 'queries', 'assets', 'http', 'hooks', 'errors', 'conditionals', 'memory' );

	/**
	 * Singleton.
	 *
	 * @var WPXMCP_Profiler|null
	 */
	private static $instance = null;

	/**
	 * Token data for the request being profiled, or null when not profiling.
	 *
	 * @var array|null
	 */
	private $active = null;

	/**
	 * Keyed hash of the token being profiled.
	 *
	 * @var string
	 */
	private $hash = '';

	/**
	 * Whether collectors should still record. Switched off before the report is stored.
	 *
	 * @var bool
	 */
	private $recording = false;

	/**
	 * Whether queries are timed through SAVEQUERIES (true) or only counted through the query filter.
	 *
	 * @var bool
	 */
	private $query_timing = false;

	/**
	 * Collected state.
	 *
	 * @var array
	 */
	private $data = array();

	/**
	 * Previously installed PHP error handler.
	 *
	 * @var callable|null
	 */
	private $previous_error_handler = null;

	/**
	 * Cached component lookups by file.
	 *
	 * @var array
	 */
	private $component_cache = array();

	/**
	 * Accessor.
	 *
	 * @return WPXMCP_Profiler
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

		// The only work an ordinary request does.
		if ( isset( $_GET[ self::PARAM ] ) && is_string( $_GET[ self::PARAM ] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			$this->maybe_start( sanitize_text_field( wp_unslash( $_GET[ self::PARAM ] ) ) ); // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		}
	}

	/* --------------------------------------------------------------------- */
	/* REST                                                                  */
	/* --------------------------------------------------------------------- */

	/**
	 * Routes.
	 */
	public function register_routes() {
		$admin = array( WPXMCP_REST::instance(), 'require_admin' );

		register_rest_route( WPXMCP_NAMESPACE, '/profile/token', array(
			'methods'             => WP_REST_Server::CREATABLE,
			'callback'            => array( $this, 'create_token' ),
			'permission_callback' => $admin,
		) );

		register_rest_route( WPXMCP_NAMESPACE, '/profile/result', array(
			'methods'             => WP_REST_Server::READABLE,
			'callback'            => array( $this, 'get_result' ),
			'permission_callback' => $admin,
		) );
	}

	/**
	 * Keyed hash of a token, so the raw token is never a storage key.
	 *
	 * @param string $token Token.
	 * @return string
	 */
	private function hash_token( $token ) {
		return substr( hash_hmac( 'sha256', (string) $token, wp_salt( 'nonce' ) ), 0, 40 );
	}

	/**
	 * Normalises a URL path for binding comparisons.
	 *
	 * @param string $path Path.
	 * @return string
	 */
	private function normalise_path( $path ) {
		$path = rawurldecode( (string) $path );
		$path = '/' . ltrim( $path, '/' );
		return '/' === $path ? '/' : untrailingslashit( $path );
	}

	/**
	 * Canonical form of a query string without the profiling token, for binding comparisons.
	 *
	 * @param string $query Raw query string.
	 * @return string
	 */
	private function normalise_query( $query ) {
		$args = array();
		wp_parse_str( (string) $query, $args );
		unset( $args[ self::PARAM ] );
		ksort( $args );
		return (string) wp_json_encode( $args );
	}

	/**
	 * Issue a single-use profiling token bound to one path.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function create_token( $request ) {
		$url = trim( (string) $request->get_param( 'url' ) );
		if ( '' === $url ) {
			$url = '/';
		}
		$parts = wp_parse_url( $url );
		if ( false === $parts ) {
			return new WP_Error( 'wpxmcp_bad_url', 'The url could not be parsed.', array( 'status' => 400 ) );
		}
		if ( isset( $parts['host'] ) ) {
			$scheme = isset( $parts['scheme'] ) ? strtolower( $parts['scheme'] ) : '';
			if ( 'http' !== $scheme && 'https' !== $scheme ) {
				return new WP_Error( 'wpxmcp_bad_url', 'Only http(s) URLs on this site can be profiled.', array( 'status' => 400 ) );
			}
		}
		$path = isset( $parts['path'] ) ? $parts['path'] : '/';

		$sections = $request->get_param( 'sections' );
		if ( is_string( $sections ) ) {
			$sections = array_filter( array_map( 'trim', explode( ',', $sections ) ) );
		}
		if ( ! is_array( $sections ) || empty( $sections ) ) {
			$sections = array_values( array_diff( self::SECTIONS, array( 'hooks' ) ) );
		}
		$sections = array_values( array_intersect( self::SECTIONS, array_map( 'strval', $sections ) ) );
		if ( empty( $sections ) ) {
			return new WP_Error( 'wpxmcp_bad_sections', 'No valid sections. Use: ' . implode( ', ', self::SECTIONS ) . '.', array( 'status' => 400 ) );
		}

		$user_id = get_current_user_id();

		// Rate limit: prune the user's index of tokens that were used or expired, then count.
		$index_key = 'wpxmcp_profile_idx_' . $user_id;
		$index     = get_transient( $index_key );
		$index     = is_array( $index ) ? $index : array();
		$now       = time();
		foreach ( $index as $hash => $expires ) {
			if ( $expires < $now || false === get_transient( 'wpxmcp_profile_req_' . $hash ) ) {
				unset( $index[ $hash ] );
			}
		}
		if ( count( $index ) >= self::MAX_OUTSTANDING ) {
			return new WP_Error(
				'wpxmcp_profile_rate_limited',
				sprintf( 'You already hold %d unused profiling tokens. Use them or wait %d seconds for them to expire.', self::MAX_OUTSTANDING, self::TOKEN_TTL ),
				array( 'status' => 429 )
			);
		}

		$token = wp_generate_password( 32, false, false );
		$hash  = $this->hash_token( $token );

		set_transient( 'wpxmcp_profile_req_' . $hash, array(
			'user_id'      => $user_id,
			'sections'     => $sections,
			'path'         => $this->normalise_path( $path ),
			'query'        => $this->normalise_query( isset( $parts['query'] ) ? $parts['query'] : '' ),
			'created'      => $now,
			'as_logged_in' => (bool) rest_sanitize_boolean( $request->get_param( 'as_logged_in' ) ),
		), self::TOKEN_TTL );

		$index[ $hash ] = $now + self::TOKEN_TTL;
		set_transient( $index_key, $index, self::TOKEN_TTL + 60 );

		return array(
			'token'       => $token,
			'profile_url' => add_query_arg( self::PARAM, $token, $url ),
			'path'        => $this->normalise_path( $path ),
			'sections'    => $sections,
			'expires_in'  => self::TOKEN_TTL,
			'note'        => 'Single use. Only a request for this path carrying the token is profiled.',
		);
	}

	/**
	 * Collect (and by default delete) a finished report.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function get_result( $request ) {
		$token = sanitize_text_field( (string) $request->get_param( 'token' ) );
		if ( '' === $token ) {
			return new WP_Error( 'wpxmcp_bad_token', 'token is required.', array( 'status' => 400 ) );
		}
		$hash   = $this->hash_token( $token );
		$result = get_transient( 'wpxmcp_profile_res_' . $hash );

		if ( ! is_array( $result ) ) {
			$pending = get_transient( 'wpxmcp_profile_req_' . $hash );
			if ( is_array( $pending ) && (int) $pending['user_id'] === get_current_user_id() ) {
				return array( 'ready' => false, 'state' => 'unused' );
			}
			return array( 'ready' => false, 'state' => 'none' );
		}
		if ( (int) $result['user_id'] !== get_current_user_id() ) {
			// Another administrator's report: indistinguishable from nothing.
			return array( 'ready' => false, 'state' => 'none' );
		}

		$keep = rest_sanitize_boolean( $request->get_param( 'keep' ) );
		if ( ! $keep ) {
			delete_transient( 'wpxmcp_profile_res_' . $hash );
		}
		unset( $result['user_id'] );
		return array( 'ready' => true, 'report' => $result );
	}

	/* --------------------------------------------------------------------- */
	/* Starting a profile                                                    */
	/* --------------------------------------------------------------------- */

	/**
	 * Validate and consume a token, then enable collectors for this request only.
	 *
	 * Invalid, expired, reused or mis-bound tokens are ignored silently: the
	 * page renders exactly as it would without the parameter.
	 *
	 * @param string $token Token from the query string.
	 */
	private function maybe_start( $token ) {
		if ( ! preg_match( '/^[A-Za-z0-9]{32}$/', $token ) ) {
			return;
		}
		$hash = $this->hash_token( $token );
		$key  = 'wpxmcp_profile_req_' . $hash;
		$req  = get_transient( $key );
		if ( ! is_array( $req ) || empty( $req['user_id'] ) || empty( $req['sections'] ) ) {
			return;
		}
		// Single use: gone before anything else happens.
		delete_transient( $key );

		$request_uri   = isset( $_SERVER['REQUEST_URI'] ) ? (string) wp_unslash( $_SERVER['REQUEST_URI'] ) : '/'; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		$request_path  = (string) wp_parse_url( $request_uri, PHP_URL_PATH );
		$request_query = (string) wp_parse_url( $request_uri, PHP_URL_QUERY );
		$query_matches = ! isset( $req['query'] ) || $this->normalise_query( $request_query ) === $req['query'];
		if ( $this->normalise_path( $request_path ) !== $req['path'] || ! $query_matches ) {
			$this->store( $hash, array(
				'user_id' => (int) $req['user_id'],
				'error'   => 'path_mismatch',
				'message' => 'The token was presented on a different URL (path or query string) than it was issued for, so nothing was profiled.',
			) );
			return;
		}

		$user = get_userdata( (int) $req['user_id'] );
		if ( ! $user || ! user_can( $user, WPXMCP_ADMIN_CAP ) ) {
			return;
		}

		$this->active    = $req;
		$this->hash      = $hash;
		$this->recording = true;
		$this->data      = array(
			'started'  => microtime( true ),
			'queries'  => array(),
			'q_count'  => 0,
			'q_time'   => 0.0,
			'dupes'    => array(),
			'http'     => array(),
			'http_open'=> array(),
			'hooks'    => array(),
			'errors'   => array(),
			'err_count'=> 0,
			'hier'     => array(),
			'parts'    => array(),
			'template' => null,
			'body'     => array(),
		);

		// A profiled response must not be cached, nor served to anyone from a cache.
		if ( ! defined( 'DONOTCACHEPAGE' ) ) {
			define( 'DONOTCACHEPAGE', true );
		}
		add_action( 'send_headers', 'nocache_headers' );

		if ( ! empty( $req['as_logged_in'] ) ) {
			$uid = (int) $req['user_id'];
			add_filter( 'determine_current_user', function () use ( $uid ) {
				return $uid;
			}, PHP_INT_MAX );
			if ( did_action( 'set_current_user' ) ) {
				wp_set_current_user( $uid );
			}
		} else {
			// Anonymous means anonymous, even if a cookie came along.
			add_filter( 'determine_current_user', '__return_zero', PHP_INT_MAX );
			if ( did_action( 'set_current_user' ) ) {
				wp_set_current_user( 0 );
			}
		}

		$on = array_flip( $req['sections'] );

		if ( isset( $on['queries'] ) ) {
			$this->start_queries();
		}
		if ( isset( $on['template'] ) ) {
			$this->start_template();
		}
		if ( isset( $on['http'] ) ) {
			add_filter( 'pre_http_request', array( $this, 'on_http_start' ), -PHP_INT_MAX, 3 );
			add_action( 'http_api_debug', array( $this, 'on_http_end' ), PHP_INT_MAX, 5 );
		}
		if ( isset( $on['hooks'] ) ) {
			add_action( 'all', array( $this, 'on_any_hook' ), 10, 1 );
		}
		if ( isset( $on['errors'] ) ) {
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_set_error_handler
			$this->previous_error_handler = set_error_handler( array( $this, 'on_php_error' ) );
		}

		// Registered after WordPress's own shutdown handler, so it runs last.
		register_shutdown_function( array( $this, 'finish' ) );
	}

	/**
	 * Query collection: SAVEQUERIES timing where possible, counting otherwise.
	 */
	private function start_queries() {
		// wpdb checks SAVEQUERIES with defined() on every query, so defining it now
		// times every query from here on — for this request only.
		if ( ! defined( 'SAVEQUERIES' ) ) {
			define( 'SAVEQUERIES', true );
		}
		global $wpdb;
		$this->data['q_before'] = isset( $wpdb->num_queries ) ? (int) $wpdb->num_queries : 0;
		if ( SAVEQUERIES ) {
			$this->query_timing = true;
			add_filter( 'log_query_custom_data', array( $this, 'on_query_logged' ), PHP_INT_MAX, 5 );
		} else {
			add_filter( 'query', array( $this, 'on_query' ), PHP_INT_MAX );
		}
	}

	/**
	 * Template collection hooks.
	 */
	private function start_template() {
		$types = array( 'index', '404', 'archive', 'author', 'category', 'tag', 'taxonomy', 'date', 'embed', 'home', 'frontpage', 'privacypolicy', 'page', 'paged', 'search', 'single', 'singular', 'attachment' );
		foreach ( $types as $type ) {
			add_filter( "{$type}_template_hierarchy", array( $this, 'on_hierarchy' ), PHP_INT_MAX );
		}
		add_filter( 'template_include', array( $this, 'on_template_include' ), PHP_INT_MAX );
		add_filter( 'body_class', array( $this, 'on_body_class' ), PHP_INT_MAX );
		add_filter( 'render_block_data', array( $this, 'on_render_block_data' ), PHP_INT_MAX );
	}

	/* --------------------------------------------------------------------- */
	/* Collectors                                                            */
	/* --------------------------------------------------------------------- */

	/**
	 * A timed query (SAVEQUERIES path).
	 *
	 * @param array  $query_data Custom data.
	 * @param string $query      SQL.
	 * @param float  $query_time Seconds.
	 * @return array
	 */
	public function on_query_logged( $query_data, $query = '', $query_time = 0.0 ) {
		if ( $this->recording ) {
			$this->record_query( (string) $query, (float) $query_time * 1000 );
		}
		return $query_data;
	}

	/**
	 * An untimed query (fallback when SAVEQUERIES is defined false).
	 *
	 * @param string $query SQL.
	 * @return string
	 */
	public function on_query( $query ) {
		if ( $this->recording && is_string( $query ) && '' !== $query ) {
			$this->record_query( $query, null );
		}
		return $query;
	}

	/**
	 * Aggregate one query.
	 *
	 * @param string     $sql SQL.
	 * @param float|null $ms  Duration.
	 */
	private function record_query( $sql, $ms ) {
		$caller = $this->caller( array( 'wpdb' ) );

		++$this->data['q_count'];
		if ( null !== $ms ) {
			$this->data['q_time'] += $ms;
		}

		$clean = (string) preg_replace( '/\s+/', ' ', trim( $sql ) );
		$sig   = md5( $clean );
		if ( ! isset( $this->data['dupes'][ $sig ] ) ) {
			$this->data['dupes'][ $sig ] = array(
				'sql'     => $this->truncate( $clean, 500 ),
				'count'   => 0,
				'ms'      => 0.0,
				'callers' => array(),
			);
		}
		$dupe = &$this->data['dupes'][ $sig ];
		++$dupe['count'];
		$dupe['ms'] += (float) $ms;
		if ( count( $dupe['callers'] ) < 5 && ! in_array( $caller['caller'], $dupe['callers'], true ) ) {
			$dupe['callers'][] = $caller['caller'];
		}
		unset( $dupe );

		// Keep the slowest 200 in full; the rest only contribute to totals.
		$entry = array(
			'sql'       => $this->truncate( $clean, 500 ),
			'ms'        => null === $ms ? null : round( $ms, 3 ),
			'caller'    => $caller['caller'],
			'file'      => $caller['file'],
			'component' => $caller['component'],
			'type'      => strtoupper( (string) strtok( ltrim( $sql, " \t\n\r(" ), " \t\n\r" ) ),
		);
		$this->data['queries'][] = $entry;
		if ( count( $this->data['queries'] ) > 400 ) {
			usort( $this->data['queries'], array( $this, 'by_ms_desc' ) );
			$this->data['queries'] = array_slice( $this->data['queries'], 0, 200 );
		}
	}

	/**
	 * Sort helper.
	 *
	 * @param array $a A.
	 * @param array $b B.
	 * @return int
	 */
	public function by_ms_desc( $a, $b ) {
		$x = isset( $a['ms'] ) ? (float) $a['ms'] : 0.0;
		$y = isset( $b['ms'] ) ? (float) $b['ms'] : 0.0;
		if ( $x === $y ) {
			return 0;
		}
		return $x < $y ? 1 : -1;
	}

	/**
	 * Outbound HTTP request start.
	 *
	 * @param mixed  $pre  Short-circuit value.
	 * @param array  $args Request args.
	 * @param string $url  URL.
	 * @return mixed
	 */
	public function on_http_start( $pre, $args = array(), $url = '' ) {
		if ( $this->recording && count( $this->data['http'] ) + count( $this->data['http_open'] ) < 100 ) {
			$caller                                    = $this->caller( array( 'WP_Http' ) );
			$this->data['http_open'][ md5( $url ) ][] = array(
				'url'       => $this->redact_url( $url ),
				'method'    => isset( $args['method'] ) ? (string) $args['method'] : 'GET',
				'blocking'  => ! isset( $args['blocking'] ) || (bool) $args['blocking'],
				'start'     => microtime( true ),
				'caller'    => $caller['caller'],
				'component' => $caller['component'],
			);
		}
		return $pre;
	}

	/**
	 * Outbound HTTP request finished.
	 *
	 * @param mixed  $response Response or WP_Error.
	 * @param string $context  Context.
	 * @param string $class    Transport class.
	 * @param array  $args     Args.
	 * @param string $url      URL.
	 */
	public function on_http_end( $response, $context = '', $class = '', $args = array(), $url = '' ) {
		if ( ! $this->recording ) {
			return;
		}
		$key = md5( (string) $url );
		if ( empty( $this->data['http_open'][ $key ] ) ) {
			return;
		}
		$call = array_shift( $this->data['http_open'][ $key ] );
		if ( empty( $this->data['http_open'][ $key ] ) ) {
			unset( $this->data['http_open'][ $key ] );
		}
		$call['ms'] = round( ( microtime( true ) - $call['start'] ) * 1000, 1 );
		unset( $call['start'] );
		if ( is_wp_error( $response ) ) {
			$call['status'] = null;
			$call['error']  = $this->truncate( $response->get_error_message(), 200 );
		} else {
			$code           = wp_remote_retrieve_response_code( $response );
			$call['status'] = '' === $code ? null : (int) $code;
		}
		$this->data['http'][] = $call;
	}

	/**
	 * Every hook fired (only when the hooks section is requested).
	 *
	 * @param string $hook Hook name.
	 */
	public function on_any_hook( $hook ) {
		if ( $this->recording && is_string( $hook ) ) {
			if ( isset( $this->data['hooks'][ $hook ] ) ) {
				++$this->data['hooks'][ $hook ];
			} elseif ( count( $this->data['hooks'] ) < 5000 ) {
				$this->data['hooks'][ $hook ] = 1;
			}
		}
	}

	/**
	 * Chained PHP error handler. Never swallows the error.
	 *
	 * @param int    $errno   Level.
	 * @param string $errstr  Message.
	 * @param string $errfile File.
	 * @param int    $errline Line.
	 * @return bool
	 */
	public function on_php_error( $errno, $errstr, $errfile = '', $errline = 0 ) {
		if ( $this->recording ) {
			++$this->data['err_count'];
			$key = md5( $errno . '|' . $errfile . '|' . $errline . '|' . $errstr );
			if ( isset( $this->data['errors'][ $key ] ) ) {
				++$this->data['errors'][ $key ]['count'];
			} elseif ( count( $this->data['errors'] ) < 100 ) {
				$this->data['errors'][ $key ] = array(
					'level'     => $this->error_level( $errno ),
					'message'   => $this->truncate( (string) $errstr, 500 ),
					'file'      => $this->relative( (string) $errfile ),
					'line'      => (int) $errline,
					'component' => $this->component( (string) $errfile ),
					'count'     => 1,
					// Silenced by @ or excluded by the site's error_reporting level: happened, but not logged.
					'silenced'  => ! ( error_reporting() & $errno ),
				);
			}
		}
		if ( $this->previous_error_handler ) {
			return (bool) call_user_func( $this->previous_error_handler, $errno, $errstr, $errfile, $errline );
		}
		return false;
	}

	/**
	 * Hierarchy candidates as each *_template_hierarchy filter runs.
	 *
	 * @param array $templates Candidates.
	 * @return array
	 */
	public function on_hierarchy( $templates ) {
		if ( $this->recording && is_array( $templates ) && count( $this->data['hier'] ) < 60 ) {
			foreach ( $templates as $t ) {
				if ( is_string( $t ) && ! in_array( $t, $this->data['hier'], true ) ) {
					$this->data['hier'][] = $t;
				}
			}
		}
		return $templates;
	}

	/**
	 * The template file WordPress will finally load.
	 *
	 * @param string $template File.
	 * @return string
	 */
	public function on_template_include( $template ) {
		if ( $this->recording ) {
			$this->data['template'] = (string) $template;
		}
		return $template;
	}

	/**
	 * Final body classes.
	 *
	 * @param array $classes Classes.
	 * @return array
	 */
	public function on_body_class( $classes ) {
		if ( $this->recording && is_array( $classes ) ) {
			$this->data['body'] = array_values( array_map( 'strval', $classes ) );
		}
		return $classes;
	}

	/**
	 * Template parts rendered by a block theme.
	 *
	 * @param array $block Parsed block.
	 * @return array
	 */
	public function on_render_block_data( $block ) {
		if ( $this->recording && is_array( $block ) && isset( $block['blockName'] ) && 'core/template-part' === $block['blockName'] && count( $this->data['parts'] ) < 50 ) {
			$attrs                  = isset( $block['attrs'] ) && is_array( $block['attrs'] ) ? $block['attrs'] : array();
			$this->data['parts'][] = array(
				'slug'  => isset( $attrs['slug'] ) ? (string) $attrs['slug'] : null,
				'theme' => isset( $attrs['theme'] ) ? (string) $attrs['theme'] : null,
				'area'  => isset( $attrs['area'] ) ? (string) $attrs['area'] : null,
			);
		}
		return $block;
	}

	/* --------------------------------------------------------------------- */
	/* Finishing                                                             */
	/* --------------------------------------------------------------------- */

	/**
	 * Build and store the report. Runs as the last shutdown function; prints nothing.
	 */
	public function finish() {
		if ( ! $this->active || ! $this->recording ) {
			return;
		}
		$this->recording = false;
		$req             = $this->active;
		global $wpdb;
		$this->data['q_request_total'] = isset( $wpdb->num_queries ) ? (int) $wpdb->num_queries : null;
		$on              = array_flip( $req['sections'] );

		try {
			$end    = microtime( true );
			$report = array(
				'user_id'  => (int) $req['user_id'],
				'version'  => 1,
				'sections' => $req['sections'],
				'request'  => $this->request_summary( $req, $end ),
			);

			if ( isset( $on['conditionals'] ) ) {
				$report['conditionals'] = $this->conditionals();
			}
			if ( isset( $on['template'] ) ) {
				$report['template'] = $this->template_report();
			}
			if ( isset( $on['queries'] ) ) {
				$report['queries'] = $this->queries_report();
			}
			if ( isset( $on['assets'] ) ) {
				$report['assets'] = $this->assets_report();
			}
			if ( isset( $on['http'] ) ) {
				$report['http'] = $this->http_report();
			}
			if ( isset( $on['hooks'] ) ) {
				$report['hooks'] = $this->hooks_report();
			}
			if ( isset( $on['errors'] ) ) {
				$report['errors'] = $this->errors_report();
			}
			if ( isset( $on['memory'] ) ) {
				$report['memory'] = $this->memory_report( $end );
			}

			$this->store( $this->hash, $this->fit( $report ) );
		} catch ( Throwable $e ) {
			$this->store( $this->hash, array(
				'user_id' => (int) $req['user_id'],
				'error'   => 'profiler_failed',
				'message' => $this->truncate( $e->getMessage(), 300 ),
			) );
		}

	}

	/**
	 * Store a report for collection.
	 *
	 * @param string $hash   Token hash.
	 * @param array  $report Report.
	 */
	private function store( $hash, $report ) {
		try {
			set_transient( 'wpxmcp_profile_res_' . $hash, $report, self::RESULT_TTL );
		} catch ( Throwable $e ) {
			unset( $e ); // Never let storage failures reach the visitor.
		}
	}

	/**
	 * Status, headers and timing of the profiled request.
	 *
	 * @param array $req Token data.
	 * @param float $end End time.
	 * @return array
	 */
	private function request_summary( $req, $end ) {
		$location     = null;
		$content_type = null;
		foreach ( headers_list() as $header ) {
			$pos = strpos( $header, ':' );
			if ( false === $pos ) {
				continue;
			}
			$name  = strtolower( trim( substr( $header, 0, $pos ) ) );
			$value = trim( substr( $header, $pos + 1 ) );
			if ( 'location' === $name ) {
				$host     = wp_parse_url( $value, PHP_URL_HOST );
				$same     = ! $host || strtolower( $host ) === strtolower( (string) wp_parse_url( home_url(), PHP_URL_HOST ) );
				$location = $same ? $this->truncate( remove_query_arg( self::PARAM, $value ), 300 ) : $this->redact_url( $value );
			} elseif ( 'content-type' === $name ) {
				$content_type = $value;
			}
		}
		$start = isset( $_SERVER['REQUEST_TIME_FLOAT'] ) ? (float) $_SERVER['REQUEST_TIME_FLOAT'] : $this->data['started'];
		$fatal = error_get_last();
		$fatal = ( $fatal && in_array( $fatal['type'], array( E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR ), true ) )
			? array(
				'message'   => $this->truncate( (string) $fatal['message'], 500 ),
				'file'      => $this->relative( (string) $fatal['file'] ),
				'line'      => (int) $fatal['line'],
				'component' => $this->component( (string) $fatal['file'] ),
			)
			: null;

		return array(
			'path'             => $req['path'],
			'method'           => isset( $_SERVER['REQUEST_METHOD'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REQUEST_METHOD'] ) ) : 'GET',
			'status'           => (int) http_response_code(),
			'content_type'     => $content_type,
			'redirect_to'      => $location,
			'as_logged_in'     => ! empty( $req['as_logged_in'] ),
			'user_logged_in'   => is_user_logged_in(),
			'server_ms'        => round( ( $end - $start ) * 1000, 1 ),
			'profiling_from_ms' => round( ( $this->data['started'] - $start ) * 1000, 1 ),
			'fatal_error'      => $fatal,
			'theme'            => get_stylesheet(),
			'parent_theme'     => get_template() !== get_stylesheet() ? get_template() : null,
		);
	}

	/**
	 * Conditional tags and the main query.
	 *
	 * @return array
	 */
	private function conditionals() {
		global $wp_query;
		$tags = array( 'is_front_page', 'is_home', 'is_singular', 'is_page', 'is_single', 'is_archive', 'is_category', 'is_tag', 'is_tax', 'is_author', 'is_search', 'is_404', 'is_feed', 'is_admin', 'is_user_logged_in', 'is_attachment', 'is_date', 'is_paged', 'is_privacy_policy', 'is_embed' );
		$out  = array( 'true' => array(), 'false' => array() );
		$has_query = isset( $wp_query ) && $wp_query instanceof WP_Query;
		foreach ( $tags as $tag ) {
			if ( ! function_exists( $tag ) ) {
				continue;
			}
			$needs_query = ! in_array( $tag, array( 'is_admin', 'is_user_logged_in' ), true );
			if ( $needs_query && ! $has_query ) {
				continue;
			}
			$out[ call_user_func( $tag ) ? 'true' : 'false' ][] = $tag;
		}

		$vars  = array();
		$noise = array( 'fields', 'cache_results', 'update_post_term_cache', 'lazy_load_term_meta', 'update_post_meta_cache', 'comments_per_page', 'order', 'suppress_filters', 'ignore_sticky_posts', 'no_found_rows', 'update_menu_item_cache' );
		if ( $has_query && is_array( $wp_query->query_vars ) ) {
			foreach ( $wp_query->query_vars as $k => $v ) {
				if ( in_array( $k, $noise, true ) || '' === $v || null === $v || false === $v || array() === $v || 0 === $v ) {
					continue;
				}
				$vars[ $k ] = is_scalar( $v ) ? $this->truncate( (string) $v, 200 ) : $this->truncate( wp_json_encode( $v ), 200 );
			}
		}

		$queried = null;
		if ( $has_query ) {
			$obj = $wp_query->get_queried_object();
			if ( $obj instanceof WP_Post ) {
				$queried = array( 'type' => 'post', 'post_type' => $obj->post_type, 'id' => (int) $obj->ID, 'slug' => $obj->post_name );
			} elseif ( $obj instanceof WP_Term ) {
				$queried = array( 'type' => 'term', 'taxonomy' => $obj->taxonomy, 'id' => (int) $obj->term_id, 'slug' => $obj->slug );
			} elseif ( $obj instanceof WP_User ) {
				$queried = array( 'type' => 'user', 'id' => (int) $obj->ID, 'slug' => $obj->user_nicename );
			} elseif ( $obj instanceof WP_Post_Type ) {
				$queried = array( 'type' => 'post_type_archive', 'post_type' => $obj->name );
			}
		}

		return array(
			'true'           => $out['true'],
			'false'          => $out['false'],
			'request_vars'   => $has_query && is_array( $wp_query->query ) ? array_map( array( $this, 'scalarise' ), $wp_query->query ) : array(),
			'query_vars'     => $vars,
			'queried_object' => $queried,
			'found_posts'    => $has_query ? (int) $wp_query->found_posts : null,
			'post_count'     => $has_query ? (int) $wp_query->post_count : null,
		);
	}

	/**
	 * Template resolution.
	 *
	 * @return array
	 */
	private function template_report() {
		$file   = $this->data['template'];
		$block  = function_exists( 'wp_is_block_theme' ) && wp_is_block_theme();
		$report = array(
			'file'           => $file ? $this->relative( $file ) : null,
			'file_component' => $file ? $this->component( $file ) : null,
			'is_block_theme' => $block,
			'is_child_theme' => is_child_theme(),
			'hierarchy'      => $this->data['hier'],
			'body_classes'   => $this->data['body'],
		);
		if ( $file && is_child_theme() ) {
			$child = wp_normalize_path( get_stylesheet_directory() );
			$report['from_child_theme'] = 0 === strpos( wp_normalize_path( $file ), trailingslashit( $child ) );
		}

		if ( $block ) {
			global $_wp_current_template_id;
			$id = isset( $_wp_current_template_id ) ? (string) $_wp_current_template_id : null;
			$report['block_template'] = null;
			if ( $id ) {
				$info = array( 'id' => $id, 'slug' => null, 'source' => null, 'has_theme_file' => null, 'customized_in_database' => null );
				$pos  = strpos( $id, '//' );
				if ( false !== $pos ) {
					$info['slug'] = substr( $id, $pos + 2 );
				}
				if ( function_exists( 'get_block_template' ) ) {
					$tpl = get_block_template( $id, 'wp_template' );
					if ( $tpl ) {
						$info['slug']                   = $tpl->slug;
						$info['source']                 = $tpl->source;
						$info['has_theme_file']         = (bool) $tpl->has_theme_file;
						$info['customized_in_database'] = 'custom' === $tpl->source;
						$info['title']                  = $tpl->title;
					}
				}
				$report['block_template'] = $info;
			}
			$parts = array();
			foreach ( $this->data['parts'] as $part ) {
				$pkey = $part['theme'] . '//' . $part['slug'];
				if ( ! isset( $parts[ $pkey ] ) ) {
					$part['customized_in_database'] = null;
					if ( $part['slug'] && function_exists( 'get_block_template' ) ) {
						$theme = $part['theme'] ? $part['theme'] : get_stylesheet();
						$pt    = get_block_template( $theme . '//' . $part['slug'], 'wp_template_part' );
						if ( $pt ) {
							$part['customized_in_database'] = 'custom' === $pt->source;
							$part['area']                   = $pt->area;
						}
					}
					$parts[ $pkey ] = $part;
				}
			}
			$report['template_parts'] = array_values( $parts );
		}
		return $report;
	}

	/**
	 * Query totals, slowest queries and duplicates.
	 *
	 * @return array
	 */
	private function queries_report() {
		global $wpdb;
		$slow = $this->data['queries'];
		usort( $slow, array( $this, 'by_ms_desc' ) );

		$dupes = array();
		foreach ( $this->data['dupes'] as $d ) {
			if ( $d['count'] > 1 ) {
				$d['ms'] = round( $d['ms'], 2 );
				$dupes[] = $d;
			}
		}
		usort( $dupes, function ( $a, $b ) {
			return $b['count'] - $a['count'];
		} );

		$by_component = array();
		foreach ( $this->data['queries'] as $q ) {
			$c = $q['component'];
			if ( ! isset( $by_component[ $c ] ) ) {
				$by_component[ $c ] = array( 'component' => $c, 'count' => 0, 'ms' => 0.0 );
			}
			++$by_component[ $c ]['count'];
			$by_component[ $c ]['ms'] += (float) $q['ms'];
		}
		foreach ( $by_component as &$c ) {
			$c['ms'] = round( $c['ms'], 2 );
		}
		unset( $c );

		$total_all = $this->data['q_request_total'];
		return array(
			'count'                  => $this->data['q_count'],
			'total_ms'               => $this->query_timing ? round( $this->data['q_time'], 2 ) : null,
			'timed'                  => $this->query_timing,
			'queries_before_profiler' => isset( $this->data['q_before'] ) ? $this->data['q_before'] : null,
			'request_total'          => $total_all,
			'slowest'                => array_slice( $slow, 0, 50 ),
			'duplicates'             => array_slice( $dupes, 0, 30 ),
			'duplicate_groups'       => count( $dupes ),
			'by_component'           => array_values( $by_component ),
			'by_component_note'      => count( $this->data['queries'] ) < $this->data['q_count'] ? 'Component breakdown covers the slowest 200 queries only.' : null,
		);
	}

	/**
	 * Printed scripts and styles.
	 *
	 * @return array
	 */
	private function assets_report() {
		global $wp_scripts, $wp_styles;
		$out = array();
		foreach ( array( 'scripts' => $wp_scripts, 'styles' => $wp_styles ) as $kind => $deps ) {
			$list = array();
			if ( $deps instanceof WP_Dependencies ) {
				$footer = isset( $deps->in_footer ) && is_array( $deps->in_footer ) ? $deps->in_footer : array();
				foreach ( (array) $deps->done as $handle ) {
					if ( ! isset( $deps->registered[ $handle ] ) || count( $list ) >= 150 ) {
						continue;
					}
					$dep  = $deps->registered[ $handle ];
					$src  = is_string( $dep->src ) ? $dep->src : '';
					$path = $this->local_asset_path( $src );
					$size = null;
					if ( $path && is_file( $path ) ) {
						$size = (int) filesize( $path );
					}
					$list[] = array(
						'handle'     => (string) $handle,
						'src'        => '' === $src ? null : $this->relative_url( $src ),
						'deps'       => array_values( (array) $dep->deps ),
						'ver'        => false === $dep->ver ? null : ( null === $dep->ver ? null : (string) $dep->ver ),
						'in_footer'  => 'scripts' === $kind ? in_array( $handle, $footer, true ) : null,
						'size_bytes' => $size,
						'component'  => '' === $src ? 'inline' : $this->component_from_url( $src ),
					);
				}
			}
			$total = 0;
			foreach ( $list as $item ) {
				$total += (int) $item['size_bytes'];
			}
			$out[ $kind ] = array(
				'count'            => count( $list ),
				'known_size_bytes' => $total,
				'items'            => $list,
			);
		}
		// Script modules (WordPress 6.9+ exposes the queue; 7.0+ the registration data).
		if ( function_exists( 'wp_script_modules' ) && method_exists( 'WP_Script_Modules', 'get_queue' ) ) {
			$modules = array();
			$sm      = wp_script_modules();
			foreach ( array_slice( (array) $sm->get_queue(), 0, 100 ) as $id ) {
				$reg  = method_exists( $sm, 'get_registered' ) ? $sm->get_registered( $id ) : null;
				$src  = is_array( $reg ) && isset( $reg['src'] ) && is_string( $reg['src'] ) ? $reg['src'] : '';
				$path = $this->local_asset_path( $src );
				$modules[] = array(
					'handle'     => (string) $id,
					'src'        => '' === $src ? null : $this->relative_url( $src ),
					'deps'       => array(),
					'ver'        => is_array( $reg ) && isset( $reg['version'] ) && is_string( $reg['version'] ) ? $reg['version'] : null,
					'in_footer'  => null,
					'size_bytes' => $path && is_file( $path ) ? (int) filesize( $path ) : null,
					'component'  => '' === $src ? 'inline' : $this->component_from_url( $src ),
				);
			}
			$total = 0;
			foreach ( $modules as $item ) {
				$total += (int) $item['size_bytes'];
			}
			$out['script_modules'] = array( 'count' => count( $modules ), 'known_size_bytes' => $total, 'items' => $modules );
		}
		return $out;
	}

	/**
	 * Outbound HTTP calls.
	 *
	 * @return array
	 */
	private function http_report() {
		$calls = $this->data['http'];
		foreach ( $this->data['http_open'] as $pending ) {
			foreach ( $pending as $call ) {
				unset( $call['start'] );
				$call['ms']     = null;
				$call['status'] = null;
				$call['note']   = 'short-circuited by pre_http_request or never completed';
				$calls[]        = $call;
			}
		}
		$total = 0.0;
		foreach ( $calls as $c ) {
			$total += (float) $c['ms'];
		}
		return array( 'count' => count( $calls ), 'total_ms' => round( $total, 1 ), 'calls' => $calls );
	}

	/**
	 * Most-fired hooks.
	 *
	 * @return array
	 */
	private function hooks_report() {
		global $wp_filter;
		$hooks = $this->data['hooks'];
		arsort( $hooks );
		$top = array();
		foreach ( array_slice( $hooks, 0, 20, true ) as $name => $fires ) {
			$callbacks = 0;
			if ( isset( $wp_filter[ $name ] ) && $wp_filter[ $name ] instanceof WP_Hook ) {
				foreach ( $wp_filter[ $name ]->callbacks as $priority ) {
					$callbacks += count( $priority );
				}
			}
			$top[] = array( 'hook' => (string) $name, 'fires' => $fires, 'callbacks' => $callbacks );
		}
		return array(
			'distinct_hooks' => count( $hooks ),
			'total_fires'    => array_sum( $hooks ),
			'top'            => $top,
		);
	}

	/**
	 * PHP errors captured.
	 *
	 * @return array
	 */
	private function errors_report() {
		$reported = 0;
		foreach ( $this->data['errors'] as $e ) {
			if ( empty( $e['silenced'] ) ) {
				$reported += $e['count'];
			}
		}
		return array(
			'reported_count' => $reported,
			'count'  => $this->data['err_count'],
			'items'  => array_values( $this->data['errors'] ),
		);
	}

	/**
	 * Memory, time, files and object cache.
	 *
	 * @param float $end End time.
	 * @return array
	 */
	private function memory_report( $end ) {
		global $wp_object_cache;
		$start = isset( $_SERVER['REQUEST_TIME_FLOAT'] ) ? (float) $_SERVER['REQUEST_TIME_FLOAT'] : $this->data['started'];
		$cache = array( 'persistent' => (bool) wp_using_ext_object_cache() );
		if ( is_object( $wp_object_cache ) ) {
			if ( isset( $wp_object_cache->cache_hits ) ) {
				$cache['hits'] = (int) $wp_object_cache->cache_hits;
			}
			if ( isset( $wp_object_cache->cache_misses ) ) {
				$cache['misses'] = (int) $wp_object_cache->cache_misses;
			}
			if ( isset( $cache['hits'], $cache['misses'] ) && ( $cache['hits'] + $cache['misses'] ) > 0 ) {
				$cache['hit_rate'] = round( $cache['hits'] / ( $cache['hits'] + $cache['misses'] ), 3 );
			}
		}
		$limit = wp_convert_hr_to_bytes( (string) ini_get( 'memory_limit' ) );
		return array(
			'peak_bytes'     => memory_get_peak_usage(),
			'peak_real_bytes'=> memory_get_peak_usage( true ),
			'limit_bytes'    => $limit > 0 ? $limit : null,
			'php_ms'         => round( ( $end - $start ) * 1000, 1 ),
			'included_files' => count( get_included_files() ),
			'object_cache'   => $cache,
			'php_version'    => PHP_VERSION,
		);
	}

	/**
	 * Truncates lists until the report fits the storage cap.
	 *
	 * @param array $report Report.
	 * @return array
	 */
	private function fit( $report ) {
		$caps = array( 30, 15, 5 );
		foreach ( $caps as $cap ) {
			$json = wp_json_encode( $report );
			if ( false !== $json && strlen( $json ) <= self::MAX_REPORT_BYTES ) {
				return $report;
			}
			$report['truncated'] = true;
			if ( isset( $report['queries'] ) ) {
				$report['queries']['slowest']    = array_slice( $report['queries']['slowest'], 0, $cap );
				$report['queries']['duplicates'] = array_slice( $report['queries']['duplicates'], 0, $cap );
			}
			foreach ( array( 'scripts', 'styles' ) as $kind ) {
				if ( isset( $report['assets'][ $kind ]['items'] ) ) {
					$report['assets'][ $kind ]['items'] = array_slice( $report['assets'][ $kind ]['items'], 0, $cap * 2 );
				}
			}
			if ( isset( $report['errors']['items'] ) ) {
				$report['errors']['items'] = array_slice( $report['errors']['items'], 0, $cap );
			}
			if ( isset( $report['http']['calls'] ) ) {
				$report['http']['calls'] = array_slice( $report['http']['calls'], 0, $cap );
			}
			if ( isset( $report['template']['body_classes'] ) ) {
				$report['template']['body_classes'] = array_slice( $report['template']['body_classes'], 0, $cap );
			}
		}
		return $report;
	}

	/* --------------------------------------------------------------------- */
	/* Attribution helpers                                                   */
	/* --------------------------------------------------------------------- */

	/**
	 * The first meaningful frame outside the given classes and hook plumbing.
	 *
	 * @param array $skip_classes Classes (and subclasses) to skip.
	 * @return array{caller:string,file:?string,component:string}
	 */
	private function caller( $skip_classes ) {
		// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_debug_backtrace
		$trace     = debug_backtrace( DEBUG_BACKTRACE_IGNORE_ARGS, 40 );
		$plumbing  = array( 'apply_filters', 'do_action', 'apply_filters_ref_array', 'do_action_ref_array', 'call_user_func', 'call_user_func_array' );
		$caller    = null;
		$file      = null;
		$component = null;
		$count     = count( $trace );

		for ( $i = 1; $i < $count; $i++ ) {
			$frame = $trace[ $i ];
			$class = isset( $frame['class'] ) ? $frame['class'] : '';
			$fn    = isset( $frame['function'] ) ? $frame['function'] : '';
			if ( __CLASS__ === $class || 'WP_Hook' === $class || in_array( $fn, $plumbing, true ) ) {
				continue;
			}
			$skip = false;
			foreach ( $skip_classes as $sc ) {
				if ( '' !== $class && ( $class === $sc || is_subclass_of( $class, $sc ) ) ) {
					$skip = true;
					break;
				}
			}
			if ( $skip ) {
				continue;
			}
			if ( null === $caller ) {
				$caller = ( '' !== $class ? $class . ( isset( $frame['type'] ) ? $frame['type'] : '->' ) : '' ) . $fn . '()';
				// The file of the previous frame is where this function made the call.
				$prev = $trace[ $i - 1 ];
				if ( isset( $prev['file'] ) ) {
					$file = $this->relative( $prev['file'] ) . ':' . ( isset( $prev['line'] ) ? (int) $prev['line'] : 0 );
				}
			}
			if ( isset( $trace[ $i - 1 ]['file'] ) ) {
				$c = $this->component( $trace[ $i - 1 ]['file'] );
				if ( 'core' !== $c && 'other' !== $c ) {
					$component = $c;
					break;
				}
			}
		}
		if ( null !== $caller && false !== strpos( $caller, '{closure:' ) ) {
			$self   = $this;
			$caller = (string) preg_replace_callback( '/\{closure:(.+?):(\d+)\}/', function ( $m ) use ( $self ) {
				return '{closure:' . $self->relative_path( $m[1] ) . ':' . $m[2] . '}';
			}, $caller );
		}
		return array(
			'caller'    => null === $caller ? 'unknown' : $caller,
			'file'      => $file,
			'component' => null === $component ? 'core' : $component,
		);
	}

	/**
	 * Which component a file belongs to: core, plugin:slug, mu-plugin:slug, theme:slug or other.
	 *
	 * @param string $file Absolute path.
	 * @return string
	 */
	private function component( $file ) {
		if ( '' === $file ) {
			return 'other';
		}
		if ( isset( $this->component_cache[ $file ] ) ) {
			return $this->component_cache[ $file ];
		}
		$f      = wp_normalize_path( $file );
		$result = 'other';
		$roots  = array(
			'plugin'    => defined( 'WP_PLUGIN_DIR' ) ? WP_PLUGIN_DIR : '',
			'mu-plugin' => defined( 'WPMU_PLUGIN_DIR' ) ? WPMU_PLUGIN_DIR : '',
			'theme'     => function_exists( 'get_theme_root' ) ? get_theme_root() : '',
		);
		foreach ( $roots as $label => $root ) {
			if ( '' === $root ) {
				continue;
			}
			$root = trailingslashit( wp_normalize_path( $root ) );
			if ( 0 === strpos( $f, $root ) ) {
				$rest   = substr( $f, strlen( $root ) );
				$slug   = strtok( $rest, '/' );
				$slug   = preg_replace( '/\.php$/', '', (string) $slug );
				$result = $label . ':' . $slug;
				break;
			}
		}
		if ( 'other' === $result ) {
			$abs = trailingslashit( wp_normalize_path( ABSPATH ) );
			if ( 0 === strpos( $f, $abs . 'wp-includes/' ) || 0 === strpos( $f, $abs . 'wp-admin/' ) || ( 0 === strpos( $f, $abs ) && false === strpos( substr( $f, strlen( $abs ) ), '/' ) ) ) {
				$result = 'core';
			} elseif ( 0 === strpos( $f, trailingslashit( wp_normalize_path( WP_CONTENT_DIR ) ) ) ) {
				$result = 'wp-content';
			}
		}
		// Real paths of symlinked plugins sit outside WP_PLUGIN_DIR; match by plugin folder name.
		if ( 'other' === $result ) {
			$linked = $this->linked_plugin( $f );
			if ( $linked ) {
				$result = 'plugin:' . $linked[0];
			}
		}
		$this->component_cache[ $file ] = $result;
		return $result;
	}

	/**
	 * For a file inside a symlinked plugin folder: [slug, path inside the plugin].
	 *
	 * @param string $f Normalised absolute path.
	 * @return array|null
	 */
	private function linked_plugin( $f ) {
		static $map = null;
		if ( null === $map ) {
			$map = array();
			if ( defined( 'WP_PLUGIN_DIR' ) && is_dir( WP_PLUGIN_DIR ) ) {
				foreach ( (array) glob( WP_PLUGIN_DIR . '/*', GLOB_ONLYDIR ) as $dir ) {
					if ( is_link( $dir ) ) {
						$real = realpath( $dir );
						if ( $real ) {
							$map[ trailingslashit( wp_normalize_path( $real ) ) ] = basename( $dir );
						}
					}
				}
			}
		}
		foreach ( $map as $real => $slug ) {
			if ( 0 === strpos( $f, $real ) ) {
				return array( $slug, substr( $f, strlen( $real ) ) );
			}
		}
		return null;
	}

	/**
	 * Component for an asset URL.
	 *
	 * @param string $src URL.
	 * @return string
	 */
	private function component_from_url( $src ) {
		$path = (string) wp_parse_url( $src, PHP_URL_PATH );
		if ( preg_match( '#/(?:wp-content/)?plugins/([^/]+)/#', $path, $m ) ) {
			return 'plugin:' . $m[1];
		}
		if ( preg_match( '#/mu-plugins/([^/]+)#', $path, $m ) ) {
			return 'mu-plugin:' . preg_replace( '/\.php$/', '', $m[1] );
		}
		if ( preg_match( '#/themes/([^/]+)/#', $path, $m ) ) {
			return 'theme:' . $m[1];
		}
		if ( preg_match( '#^/?(?:[^/]+/)*wp-(?:includes|admin)/#', $path ) ) {
			return 'core';
		}
		$host = wp_parse_url( $src, PHP_URL_HOST );
		if ( $host && strtolower( $host ) !== strtolower( (string) wp_parse_url( home_url(), PHP_URL_HOST ) ) ) {
			return 'external:' . strtolower( $host );
		}
		return 'other';
	}

	/**
	 * Local file behind an asset URL, if it is one.
	 *
	 * @param string $src URL.
	 * @return string|null
	 */
	private function local_asset_path( $src ) {
		if ( '' === $src ) {
			return null;
		}
		$path = (string) wp_parse_url( $src, PHP_URL_PATH );
		$host = wp_parse_url( $src, PHP_URL_HOST );
		if ( $host && strtolower( $host ) !== strtolower( (string) wp_parse_url( site_url(), PHP_URL_HOST ) ) ) {
			return null;
		}
		$content_path = (string) wp_parse_url( content_url(), PHP_URL_PATH );
		if ( '' !== $content_path && 0 === strpos( $path, trailingslashit( $content_path ) ) ) {
			$candidate = WP_CONTENT_DIR . substr( $path, strlen( $content_path ) );
		} else {
			$site_path = (string) wp_parse_url( site_url(), PHP_URL_PATH );
			$relative  = '' !== $site_path && 0 === strpos( $path, $site_path ) ? substr( $path, strlen( $site_path ) ) : $path;
			$candidate = ABSPATH . ltrim( $relative, '/' );
		}
		if ( false !== strpos( $candidate, '..' ) ) {
			return null;
		}
		return $candidate;
	}

	/**
	 * Path relative to the WordPress root.
	 *
	 * @param string $file Absolute path.
	 * @return string
	 */
	private function relative( $file ) {
		$f = wp_normalize_path( $file );
		foreach ( array( WP_CONTENT_DIR => 'wp-content/', ABSPATH => '' ) as $root => $prefix ) {
			$root = trailingslashit( wp_normalize_path( $root ) );
			if ( 0 === strpos( $f, $root ) ) {
				return $prefix . substr( $f, strlen( $root ) );
			}
		}
		// Symlinked plugin folders resolve outside wp-content; show them where WordPress sees them.
		$linked = $this->linked_plugin( $f );
		if ( $linked ) {
			return 'wp-content/plugins/' . $linked[0] . '/' . $linked[1];
		}
		return basename( dirname( $f ) ) . '/' . basename( $f );
	}

	/**
	 * Public wrapper for relative(), for callbacks.
	 *
	 * @param string $file Absolute path.
	 * @return string
	 */
	public function relative_path( $file ) {
		return $this->relative( $file );
	}

	/**
	 * Asset URL relative to the site when local.
	 *
	 * @param string $src URL.
	 * @return string
	 */
	private function relative_url( $src ) {
		foreach ( array( site_url(), home_url() ) as $base ) {
			$base = untrailingslashit( $base );
			if ( 0 === strpos( $src, $base . '/' ) ) {
				return substr( $src, strlen( $base ) );
			}
		}
		return $this->redact_url( $src );
	}

	/**
	 * URL with query-string values removed (names kept), so keys and tokens do not leak.
	 *
	 * @param string $url URL.
	 * @return string
	 */
	private function redact_url( $url ) {
		$url = (string) $url;
		$q   = strpos( $url, '?' );
		if ( false === $q ) {
			return $this->truncate( $url, 300 );
		}
		$base  = substr( $url, 0, $q );
		$query = substr( $url, $q + 1 );
		$hash  = strpos( $query, '#' );
		if ( false !== $hash ) {
			$query = substr( $query, 0, $hash );
		}
		$names = array();
		foreach ( explode( '&', $query ) as $pair ) {
			if ( '' === $pair ) {
				continue;
			}
			$eq      = strpos( $pair, '=' );
			$names[] = ( false === $eq ? $pair : substr( $pair, 0, $eq ) ) . '=…';
		}
		// Strip credentials in the authority part as well.
		$base = preg_replace( '#^([a-z][a-z0-9+.-]*://)[^/@]*@#i', '$1', $base );
		return $this->truncate( $base . ( $names ? '?' . implode( '&', $names ) : '' ), 300 );
	}

	/**
	 * Human label for an error level.
	 *
	 * @param int $errno Level.
	 * @return string
	 */
	private function error_level( $errno ) {
		$map = array(
			E_WARNING         => 'warning',
			E_NOTICE          => 'notice',
			E_DEPRECATED      => 'deprecated',
			E_USER_WARNING    => 'warning',
			E_USER_NOTICE     => 'notice',
			E_USER_DEPRECATED => 'deprecated',
			E_USER_ERROR      => 'error',
			E_RECOVERABLE_ERROR => 'error',
		);
		return isset( $map[ $errno ] ) ? $map[ $errno ] : 'level_' . (int) $errno;
	}

	/**
	 * A short string form of any query var.
	 *
	 * @param mixed $v Value.
	 * @return string
	 */
	public function scalarise( $v ) {
		return is_scalar( $v ) ? $this->truncate( (string) $v, 200 ) : $this->truncate( (string) wp_json_encode( $v ), 200 );
	}

	/**
	 * Truncate a string.
	 *
	 * @param string $s   String.
	 * @param int    $max Max characters.
	 * @return string
	 */
	private function truncate( $s, $max ) {
		$s = (string) $s;
		if ( strlen( $s ) <= $max ) {
			return $s;
		}
		return ( function_exists( 'mb_strcut' ) ? mb_strcut( $s, 0, $max, 'UTF-8' ) : substr( $s, 0, $max ) ) . '…';
	}
}
